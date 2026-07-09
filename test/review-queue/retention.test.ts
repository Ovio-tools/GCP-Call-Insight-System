import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  getReview,
  hasBlockingReviewForCleanTranscript,
  hasBlockingReviewForRawPurge,
  listRawPurgeEligible,
  markRawPurged,
} from '../../src/db/repositories/review-queue-repo.js';
import { withTransaction } from '../../src/db/sql.js';
import { createAppPool } from '../../src/db/index.js';
import {
  hasRawTestDb,
  hasTestDb,
  makePool,
  makeRawPool,
  migrate,
  migrateRaw,
  TEST_DATABASE_URL,
} from '../db/_pg.js';
import { cleanupCalls, cleanupRawCalls, makeAppPool, seedKeyVersion } from '../db/_dal.js';

const PATTERN = 'test-ret-%';
const CAP_HOURS = 72;

describe.skipIf(!hasTestDb || !hasRawTestDb)('held-raw retention hooks (Task 6.1 ↔ 8.1)', () => {
  let owner!: Pool; // DB-A (review_queue, clean_transcripts)
  let rawOwner!: Pool; // DB-B (raw_transcripts, token_vault)
  let app!: Pool;
  let purge!: Pool;

  interface SeedOpts {
    status?: 'open' | 'in_review' | 'unresolvable' | 'resolved';
    reason?: string;
    ageHours?: number;
  }

  /** Seed a held call + one review row aged `ageHours` in the past; returns its id. */
  async function seedReview(callId: string, opts: SeedOpts = {}): Promise<string> {
    const { status = 'open', reason = 'missing_transcript', ageHours = 1 } = opts;
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const active = status === 'open' || status === 'in_review';
    const terminal = status === 'resolved' || status === 'unresolvable';
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, created_at, resolved_at)
       VALUES ($1, $2, $3,
               CASE WHEN $4 THEN now() + interval '1 hour' ELSE NULL END,
               now() - ($5 * interval '1 hour'),
               CASE WHEN $6 THEN now() ELSE NULL END)
       RETURNING id`,
      [callId, reason, status, active, ageHours, terminal],
    );
    return rows[0]!.id;
  }

  /** Seed raw_transcripts + token_vault (DB-B) whose retention_eligible_at is already in the past
   * — so they are NORMALLY purge-eligible, and only the blocking review protects them. */
  async function seedRawAndVault(callId: string): Promise<void> {
    await rawOwner.query(
      `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, retention_eligible_at)
       VALUES ($1, $2, 1, now() - interval '1 day')`,
      [callId, Buffer.from([0])],
    );
    await rawOwner.query(
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version, retention_eligible_at)
       VALUES ($1, '[NAME_1]', $2, 1, now() - interval '1 day')`,
      [callId, Buffer.from([0])],
    );
  }

  async function seedClean(callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, retention_eligible_at)
       VALUES ($1, 'redacted', 0.1, now() - interval '1 day')`,
      [callId],
    );
  }

  const eligibleIds = async (): Promise<string[]> =>
    (await listRawPurgeEligible(app, CAP_HOURS, new Date())).map((r) => r.id);

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    owner = makePool();
    rawOwner = makeRawPool();
    app = makeAppPool();
    purge = createAppPool(TEST_DATABASE_URL as string, 'purge_role');
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await cleanupRawCalls(rawOwner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await rawOwner.end();
    await app.end();
    await purge.end();
  });

  it('listRawPurgeEligible runs under the narrow purge_role grant (lean projection)', async () => {
    // The reshape (Task 8.1): the read must project ONLY the columns purge_role is granted
    // (id, call_id, status, created_at, raw_purged_at) — a SELECT * would hit assignee/
    // held_reason/sla_due_at and fail with 42501 under purge_role.
    const id = await seedReview('test-ret-lean', { status: 'unresolvable', ageHours: 100 });
    const rows = await listRawPurgeEligible(purge, CAP_HOURS, new Date());
    const found = rows.find((r) => r.id === id);
    expect(found).toBeDefined();
    // Lean shape: the sensitive review columns are absent from the candidate.
    expect(found).not.toHaveProperty('assignee');
    expect(found).not.toHaveProperty('held_reason');
    expect(found).toMatchObject({ id, call_id: 'test-ret-lean', status: 'unresolvable' });
  });

  it('an open item within the cap is recoverable — not raw-purge-eligible', async () => {
    const id = await seedReview('test-ret-open', { status: 'open', ageHours: 1 });
    expect(await eligibleIds()).not.toContain(id);
    expect((await getReview(app, id))?.raw_purged_at).toBeNull();
  });

  it('a blocking review protects normally-eligible raw/vault before the cap', async () => {
    const id = await seedReview('test-ret-block', { status: 'open', ageHours: 1 });
    await seedRawAndVault('test-ret-block'); // retention_eligible_at in the PAST

    // The predicate is true SOLELY because of the blocking review (eligibility is non-null/past).
    expect(await hasBlockingReviewForRawPurge(app, 'test-ret-block')).toBe(true);
    // Within the cap, the held-cap query does not select it either.
    expect(await eligibleIds()).not.toContain(id);
  });

  it('past the cap, an unresolvable item is hard-purge-eligible; a soft delete is NOT cap compliance', async () => {
    const id = await seedReview('test-ret-cap', { status: 'unresolvable', ageHours: 100 });
    await seedRawAndVault('test-ret-cap');
    await seedClean('test-ret-cap');

    expect(await eligibleIds()).toContain(id);

    // A mere SOFT delete of the raw (still recoverable) does NOT satisfy the cap: the item is
    // still eligible because raw_purged_at is unset.
    await rawOwner.query(
      `UPDATE raw_transcripts SET soft_deleted_at = now() WHERE call_id = 'test-ret-cap'`,
    );
    expect(await eligibleIds()).toContain(id);

    // Simulate Task 8.1/8.2d: HARD-remove raw/vault on DB-B (one DB-B tx), then stamp
    // raw_purged_at on DB-A (the separate best-effort audit mirror).
    await withTransaction(rawOwner, async (client) => {
      await client.query(`DELETE FROM token_vault WHERE call_id = 'test-ret-cap'`);
      await client.query(`DELETE FROM raw_transcripts WHERE call_id = 'test-ret-cap'`);
    });
    await markRawPurged(app, id, new Date());

    expect((await getReview(app, id))?.raw_purged_at).not.toBeNull();
    // review row + clean transcript survive; raw/vault are gone.
    expect((await owner.query(`SELECT 1 FROM review_queue WHERE id = $1`, [id])).rowCount).toBe(1);
    expect(
      (await owner.query(`SELECT 1 FROM clean_transcripts WHERE call_id = 'test-ret-cap'`))
        .rowCount,
    ).toBe(1);
    expect(
      (await rawOwner.query(`SELECT 1 FROM raw_transcripts WHERE call_id = 'test-ret-cap'`))
        .rowCount,
    ).toBe(0);
    // No longer eligible / blocking for raw, but the clean transcript stays protected.
    expect(await eligibleIds()).not.toContain(id);
    expect(await hasBlockingReviewForRawPurge(app, 'test-ret-cap')).toBe(false);
    expect(await hasBlockingReviewForCleanTranscript(app, 'test-ret-cap')).toBe(true);
  });

  it('a resolved item follows the normal window — never held-cap-eligible or blocking', async () => {
    const id = await seedReview('test-ret-resolved', { status: 'resolved', ageHours: 100 });
    expect(await eligibleIds()).not.toContain(id);
    expect(await hasBlockingReviewForRawPurge(app, 'test-ret-resolved')).toBe(false);
    expect(await hasBlockingReviewForCleanTranscript(app, 'test-ret-resolved')).toBe(false);
  });

  it('the clean transcript is protected during an active OR unresolvable review', async () => {
    await seedReview('test-ret-clean-open', { status: 'open', ageHours: 1 });
    await seedClean('test-ret-clean-open');
    expect(await hasBlockingReviewForCleanTranscript(app, 'test-ret-clean-open')).toBe(true);

    await seedReview('test-ret-clean-unres', { status: 'unresolvable', ageHours: 100 });
    await seedClean('test-ret-clean-unres');
    expect(await hasBlockingReviewForCleanTranscript(app, 'test-ret-clean-unres')).toBe(true);
  });
});
