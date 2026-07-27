import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  getCleanTranscript,
  upsertCleanTranscript,
} from '../../src/db/repositories/clean-transcripts-repo.js';
import { replaceFindings } from '../../src/db/repositories/redaction-findings-repo.js';
import { insertWebhookEvent } from '../../src/db/repositories/raw-webhook-events-repo.js';
import { markTranscriptRetentionEligible } from '../../src/db/repositories/raw-transcripts-repo.js';
import { enqueueReview } from '../../src/db/repositories/review-queue-repo.js';
import { hasBlockingReviewForCleanTranscript } from '../../src/db/repositories/review-queue-repo.js';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawAppPool,
  seedKeyVersion,
} from './_dal.js';

const PATTERN = 'test-elig-%';

describe.skipIf(!hasTestDb)('creation-time retention eligibility stamping (Task 8.1)', () => {
  let owner!: Pool;
  let app!: Pool;
  // raw_transcripts lives in DB-B (ADR 0008 Move 2). clean/findings/webhook/match_keys stay DB-A.
  let rawOwner: Pool | undefined;
  let rawApp: Pool | undefined;

  async function ensureCall(callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'processing') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  const cleanEligibleAt = async (callId: string): Promise<Date | null> => {
    const { rows } = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM clean_transcripts WHERE call_id = $1`,
      [callId],
    );
    return rows[0]?.retention_eligible_at ?? null;
  };

  const findingEligibleAt = async (callId: string): Promise<Date | null> => {
    const { rows } = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM redaction_findings
        WHERE call_id = $1 AND soft_deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [callId],
    );
    return rows[0]?.retention_eligible_at ?? null;
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    if (hasRawTestDb) {
      await migrateRaw('up');
      rawOwner = makeRawPool();
      rawApp = makeRawAppPool();
    }
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    if (rawOwner) await cleanupRawCalls(rawOwner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
    if (rawOwner) await rawOwner.end();
    if (rawApp) await rawApp.end();
  });

  it('upsertCleanTranscript stamps retention_eligible_at at creation', async () => {
    await ensureCall('test-elig-clean');
    const row = await upsertCleanTranscript(app, {
      callId: 'test-elig-clean',
      redactedText: 'redacted',
      redactionRiskScore: 0.1,
    });
    expect(row.retention_eligible_at).not.toBeNull();
  });

  it('upsertCleanTranscript is monotonic — a re-run never resets the clock', async () => {
    await ensureCall('test-elig-clean-mono');
    await upsertCleanTranscript(app, {
      callId: 'test-elig-clean-mono',
      redactedText: 'v1',
      redactionRiskScore: 0.1,
    });
    // Pin the stamp to a fixed past value, then re-upsert; COALESCE must keep it.
    await owner.query(
      `UPDATE clean_transcripts SET retention_eligible_at = '2000-01-01T00:00:00Z' WHERE call_id = $1`,
      ['test-elig-clean-mono'],
    );
    await upsertCleanTranscript(app, {
      callId: 'test-elig-clean-mono',
      redactedText: 'v2',
      redactionRiskScore: 0.2,
    });
    expect((await cleanEligibleAt('test-elig-clean-mono'))?.toISOString()).toBe(
      '2000-01-01T00:00:00.000Z',
    );
  });

  it('replaceFindings stamps at creation and keeps the original clock across reruns', async () => {
    await ensureCall('test-elig-find');
    await replaceFindings(app, 'test-elig-find', [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]);
    expect(await findingEligibleAt('test-elig-find')).not.toBeNull();

    // Pin the first set's stamp to the past, then replace: the new rows must inherit that
    // minimum (COALESCE over the call's existing findings), not a fresh now().
    await owner.query(
      `UPDATE redaction_findings SET retention_eligible_at = '2000-01-01T00:00:00Z' WHERE call_id = $1`,
      ['test-elig-find'],
    );
    await replaceFindings(app, 'test-elig-find', [{ entityType: 'PHONE', tokenRef: '[PHONE_1]' }]);
    expect((await findingEligibleAt('test-elig-find'))?.toISOString()).toBe(
      '2000-01-01T00:00:00.000Z',
    );
  });

  it('insertWebhookEvent stamps raw_webhook_events at receipt', async () => {
    const row = await insertWebhookEvent(app, { source: 'dialpad', signatureStatus: 'valid' });
    expect(row.retention_eligible_at).not.toBeNull();
    await owner.query(`DELETE FROM raw_webhook_events WHERE id = $1`, [row.id]);
  });

  it.skipIf(!hasRawTestDb)(
    'mark-retention-eligible still stamps raw transcripts (raw/vault path unchanged)',
    async () => {
      // raw_transcripts now lives in DB-B, with no cross-DB FK to call_state.
      await rawOwner!.query(
        `INSERT INTO raw_transcripts (call_id, ciphertext, key_version) VALUES ($1, $2, 1)`,
        ['test-elig-raw', Buffer.from([1])],
      );
      // Not stamped at insert (raw eligibility is post-store).
      const before = await rawOwner!.query<{ retention_eligible_at: Date | null }>(
        `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
        ['test-elig-raw'],
      );
      expect(before.rows[0]?.retention_eligible_at).toBeNull();
      await markTranscriptRetentionEligible(rawApp!, 'test-elig-raw');
      const after = await rawOwner!.query<{ retention_eligible_at: Date | null }>(
        `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
        ['test-elig-raw'],
      );
      expect(after.rows[0]?.retention_eligible_at).not.toBeNull();
    },
  );

  it('a held call that never completes still has clean/findings stamped + blocked', async () => {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
      ['test-elig-held'],
    );
    await upsertCleanTranscript(app, {
      callId: 'test-elig-held',
      redactedText: 'redacted',
      redactionRiskScore: 0.1,
    });
    await replaceFindings(app, 'test-elig-held', [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]);
    await enqueueReview(app, {
      callId: 'test-elig-held',
      heldReason: 'residual_pii_detected',
      slaDueAt: new Date(Date.now() + 3_600_000),
    });
    expect(await cleanEligibleAt('test-elig-held')).not.toBeNull();
    expect(await findingEligibleAt('test-elig-held')).not.toBeNull();
    // Eligible but review-blocked: the purge predicate must skip it while review is active.
    expect(await hasBlockingReviewForCleanTranscript(app, 'test-elig-held')).toBe(true);
    expect((await getCleanTranscript(app, 'test-elig-held'))?.retention_eligible_at).not.toBeNull();
  });

  // Skips (not vacuous-passes) without DB-B: this exercises BOTH the DB-A migration-013 backfill
  // AND the DB-B "raw not backfilled" guarantee in one migration cycle, so it needs the raw store.
  it.skipIf(!hasRawTestDb)(
    'migration 013 backfills pre-existing NULL clean/findings/webhook (not raw)',
    async () => {
      await ensureCall('test-elig-bf');
      await upsertCleanTranscript(app, {
        callId: 'test-elig-bf',
        redactedText: 'redacted',
        redactionRiskScore: 0.1,
      });
      await replaceFindings(app, 'test-elig-bf', [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]);
      const wh = await insertWebhookEvent(app, { source: 'dialpad', signatureStatus: 'valid' });
      // raw_transcripts now lives in DB-B (ADR 0008 Move 2). Seed a NULL-stamped raw row there to
      // prove the DB-A migration-013 backfill provably cannot reach it (raw is post-store eligibility
      // only, and cross-DB now doubly guarantees the migration never stamps it).
      await rawOwner!.query(
        `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, retention_eligible_at)
       VALUES ($1, $2, 1, NULL)`,
        ['test-elig-bf', Buffer.from([1])],
      );
      // Simulate pre-stamping rows: null out eligibility everywhere (DB-A tables).
      await owner.query(
        `UPDATE clean_transcripts SET retention_eligible_at = NULL WHERE call_id = $1`,
        ['test-elig-bf'],
      );
      await owner.query(
        `UPDATE redaction_findings SET retention_eligible_at = NULL WHERE call_id = $1`,
        ['test-elig-bf'],
      );
      await owner.query(
        `UPDATE raw_webhook_events SET retention_eligible_at = NULL WHERE id = $1`,
        [wh.id],
      );
      // A pre-existing match_keys row with no eligibility stamp (its writer predates the stamping
      // fix) — must be backfilled, else it would be immortal to the purge predicate.
      await owner.query(
        `INSERT INTO match_keys (call_id, phone_hmac, name_hmac, key_version, retention_eligible_at)
       VALUES ($1, 'p', 'n', 1, NULL)`,
        ['test-elig-bf'],
      );

      // Re-run migration 013 → its forward-only backfill stamps clean/findings/webhook/match_keys.
      // down 12 rolls back 1782864100004 (below_minimum_duration drop reason) +
      // 1782864100003 (structured_knowledge.superseded_by_call_id) +
      // 1782864100002 (duplicate_call_leg drop reason) + 1782864100001 (grinder_pump
      // service_category) + 1782864100000 (drop raw/vault from DB-A, ADR 0008 Move 2) + 019
      // (kek_versions app read grant) + 018 (backfill run status, Task 11.2) + 017 (key lifecycle,
      // Task 8.2) + 016 (labeled_examples, Task 6.3) + 015 (reprocess_requests) + 014 (reveal_raw
      // enum) — all stacked above 013 — then 013 itself; the following `up` re-applies all twelve,
      // re-running 013's backfill. (The drop migration's down() transiently recreates raw/vault in
      // DB-A while rolled down, but 013's backfill never touches raw, and the drop re-applies on the
      // way up, so DB-A ends with no raw_transcripts.)
      await migrate('down', 12);
      await migrate('up');

      expect(await cleanEligibleAt('test-elig-bf')).not.toBeNull();
      expect(await findingEligibleAt('test-elig-bf')).not.toBeNull();
      const whAfter = await owner.query<{ retention_eligible_at: Date | null }>(
        `SELECT retention_eligible_at FROM raw_webhook_events WHERE id = $1`,
        [wh.id],
      );
      expect(whAfter.rows[0]?.retention_eligible_at).not.toBeNull();
      const mkAfter = await owner.query<{ retention_eligible_at: Date | null }>(
        `SELECT retention_eligible_at FROM match_keys WHERE call_id = $1`,
        ['test-elig-bf'],
      );
      expect(mkAfter.rows[0]?.retention_eligible_at).not.toBeNull();
      // Raw is intentionally NOT backfilled (post-store eligibility only) — and it lives in DB-B,
      // which the DB-A migration cannot reach at all. Assert its stamp is still NULL on DB-B.
      const rawAfter = await rawOwner!.query<{ retention_eligible_at: Date | null }>(
        `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
        ['test-elig-bf'],
      );
      expect(rawAfter.rows[0]?.retention_eligible_at).toBeNull();

      await owner.query(`DELETE FROM raw_webhook_events WHERE id = $1`, [wh.id]);
    },
  );
});
