import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { bootstrapKey } from '../../src/key-lifecycle/bootstrap.js';

/**
 * bootstrap-key core (Task 8.2). Seeds the FIRST active KEK + DEK. Runs inside a rolled-back tx
 * with existing actives retired first, so the shared key tables are never polluted.
 */
describe.skipIf(!hasTestDb)('bootstrapKey', () => {
  let owner!: Pool;
  let dir: string;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  afterAll(async () => {
    await owner.end();
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A clean-slate tx: retire any active key_version so bootstrap sees zero actives. */
  async function inCleanTx(body: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await body(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('creates the first active KEK + DEK and writes exactly one key_bootstrapped event', async () => {
    await inCleanTx(async (c) => {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      const result = await bootstrapKey({
        db: c,
        keyStore: store,
        kekVersion: 'kek-boot',
        actor: 'ops@example',
        approvalRef: 'JIRA-1',
      });

      // One active KEK, one active DEK.
      const activeKek = (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM kek_versions WHERE status='active'`,
        )
      ).rows[0]!.n;
      const activeDek = (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM key_versions WHERE status='active'`,
        )
      ).rows[0]!.n;
      expect(activeKek).toBe(1);
      expect(activeDek).toBe(1);

      // The DEK unwraps.
      expect(await store.unwrapDek(result.keyVersion)).toHaveLength(32);

      // Exactly one key_bootstrapped event, carrying the actor + approval ref.
      const ev = (
        await c.query<{ actor: string; approval_ref: string | null }>(
          `SELECT actor, approval_ref FROM key_lifecycle_events WHERE event='key_bootstrapped'`,
        )
      ).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actor).toBe('ops@example');
      expect(ev[0]!.approval_ref).toBe('JIRA-1');
    });
  });

  it('refuses to run twice (an active key already exists)', async () => {
    await inCleanTx(async (c) => {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      await bootstrapKey({
        db: c,
        keyStore: store,
        kekVersion: 'kek-boot',
        actor: 'ops',
        reason: 'first',
      });
      await expect(
        bootstrapKey({
          db: c,
          keyStore: new LocalFileKeyStore({ dir: mkdtempSync(join(tmpdir(), 'b2-')), recoveryWindowDays: 0 }),
          kekVersion: 'kek-boot-2',
          actor: 'ops',
          reason: 'again',
        }),
      ).rejects.toThrow(/already bootstrapped|active/i);
    });
  });

  it('requires an actor and either approval-ref or reason', async () => {
    await inCleanTx(async (c) => {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      await expect(
        bootstrapKey({ db: c, keyStore: store, kekVersion: 'k', actor: '' }),
      ).rejects.toThrow(/actor/i);
      await expect(
        bootstrapKey({ db: c, keyStore: store, kekVersion: 'k', actor: 'ops' }),
      ).rejects.toThrow(/approval|reason/i);
    });
  });
});
