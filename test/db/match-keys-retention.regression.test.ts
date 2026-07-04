import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { putMatchKeys } from '../../src/db/restricted/match-keys-repo.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from './_dal.js';

/**
 * Task 8.1 ↔ Task 12.0 handoff contract (review P2), encoded so the handoff cannot be silently
 * missed. Task 8.1 ships the `match_keys` purge predicate + column-scoped grants NOW, but the
 * match-key WRITER is Task 12.0 and does not exist yet, so there is no runtime writer to import.
 *
 * This is a PENDING/static regression: it scans `src/` for any statement that writes `match_keys`.
 * While no writer exists it is a documented no-op (green). The moment Task 12.0 adds an INSERT
 * into `match_keys`, this test activates and FAILS unless that writer:
 *   (a) stamps `retention_eligible_at` at insert (so the row is not immortal — the purge predicate
 *       keys on it), and
 *   (b) preserves hard-delete finality (a `hard_deleted_at` guard on its conflict/insert path, so
 *       a purged key can never be recreated — mirroring `putToken` / `putTranscript`).
 * See docs/adr/0004 and the Task 8.1 plan §2.
 */

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

/** Recursively collect `.ts` file paths under `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** src files whose SQL inserts into match_keys (the future Task 12.0 writer). */
function matchKeyWriters(): { path: string; content: string }[] {
  return tsFiles(SRC_DIR)
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }))
    .filter((f) => /INSERT\s+INTO\s+match_keys/i.test(f.content));
}

describe('match_keys retention writer contract (Task 8.1 ↔ 12.0 handoff)', () => {
  it('any match_keys writer must stamp retention_eligible_at and preserve hard-delete finality', () => {
    const writers = matchKeyWriters();
    if (writers.length === 0) {
      // Pending: the Task 12.0 writer does not exist yet. 8.1 already ships the purge predicate +
      // grants; this guard activates automatically once a writer lands.
      return;
    }
    for (const w of writers) {
      expect(
        /retention_eligible_at/.test(w.content),
        `${w.path} writes match_keys but does not stamp retention_eligible_at (Task 8.1 §2 contract)`,
      ).toBe(true);
      expect(
        /hard_deleted_at/.test(w.content),
        `${w.path} writes match_keys but has no hard_deleted_at finality guard (Task 8.1 §6 contract)`,
      ).toBe(true);
    }
  });
});

const PATTERN = 'test-mkret-%';

/**
 * A `match_keys` writer (`putMatchKeys`) already exists (contra the plan's "not built until
 * 12.0"), so the contract above is exercised at RUNTIME here: match_keys is a purgeable table, so
 * a live writer that never stamps `retention_eligible_at` would let it accumulate forever (the
 * purge predicate keys on that column). Task 8.1 makes the writer compliant now.
 */
describe.skipIf(!hasTestDb)('putMatchKeys retention compliance (Task 8.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('stamps retention_eligible_at at insert so match_keys can purge', async () => {
    const callId = 'test-mkret-stamp';
    await upsertCallState(app, { callId, source: 'test', currentStage: 'store', status: 'processing' });
    await putMatchKeys(createRestrictedRunner(app), {
      callId,
      phoneHmac: Buffer.from('p'),
      keyVersion: 1,
    });
    const { rows } = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM match_keys WHERE call_id = $1`,
      [callId],
    );
    expect(rows[0]?.retention_eligible_at).not.toBeNull();
  });

  it('refuses to recreate a hard-deleted (crypto-shredded) match key — retention finality', async () => {
    const callId = 'test-mkret-final';
    await upsertCallState(app, { callId, source: 'test', currentStage: 'store', status: 'processing' });
    const runner = createRestrictedRunner(app);
    await putMatchKeys(runner, { callId, phoneHmac: Buffer.from('p'), keyVersion: 1 });
    await owner.query(`UPDATE match_keys SET hard_deleted_at = now() WHERE call_id = $1`, [callId]);

    await expect(
      putMatchKeys(runner, { callId, phoneHmac: Buffer.from('q'), keyVersion: 1 }),
    ).rejects.toThrow(/retention conflict/);
  });
});
