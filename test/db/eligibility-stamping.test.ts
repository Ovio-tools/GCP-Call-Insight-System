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
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from './_dal.js';

const PATTERN = 'test-elig-%';

describe.skipIf(!hasTestDb)('creation-time retention eligibility stamping (Task 8.1)', () => {
  let owner!: Pool;
  let app!: Pool;

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
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
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

  it('mark-retention-eligible still stamps raw transcripts (raw/vault path unchanged)', async () => {
    await ensureCall('test-elig-raw');
    await owner.query(
      `INSERT INTO raw_transcripts (call_id, ciphertext, key_version) VALUES ($1, $2, 1)`,
      ['test-elig-raw', Buffer.from([1])],
    );
    // Not stamped at insert (raw eligibility is post-store).
    const before = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
      ['test-elig-raw'],
    );
    expect(before.rows[0]?.retention_eligible_at).toBeNull();
    await markTranscriptRetentionEligible(app, 'test-elig-raw');
    const after = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
      ['test-elig-raw'],
    );
    expect(after.rows[0]?.retention_eligible_at).not.toBeNull();
  });

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

  it('migration 013 backfills pre-existing NULL-stamped clean/findings/webhook (not raw)', async () => {
    await ensureCall('test-elig-bf');
    await upsertCleanTranscript(app, {
      callId: 'test-elig-bf',
      redactedText: 'redacted',
      redactionRiskScore: 0.1,
    });
    await replaceFindings(app, 'test-elig-bf', [{ entityType: 'NAME', tokenRef: '[NAME_1]' }]);
    const wh = await insertWebhookEvent(app, { source: 'dialpad', signatureStatus: 'valid' });
    await owner.query(
      `INSERT INTO raw_transcripts (call_id, ciphertext, key_version) VALUES ($1, $2, 1)`,
      ['test-elig-bf', Buffer.from([1])],
    );
    // Simulate pre-stamping rows: null out eligibility everywhere.
    await owner.query(`UPDATE clean_transcripts SET retention_eligible_at = NULL WHERE call_id = $1`, [
      'test-elig-bf',
    ]);
    await owner.query(`UPDATE redaction_findings SET retention_eligible_at = NULL WHERE call_id = $1`, [
      'test-elig-bf',
    ]);
    await owner.query(`UPDATE raw_webhook_events SET retention_eligible_at = NULL WHERE id = $1`, [
      wh.id,
    ]);
    await owner.query(`UPDATE raw_transcripts SET retention_eligible_at = NULL WHERE call_id = $1`, [
      'test-elig-bf',
    ]);

    // Re-run migration 013 → its forward-only backfill stamps clean/findings/webhook.
    await migrate('down', 1);
    await migrate('up');

    expect(await cleanEligibleAt('test-elig-bf')).not.toBeNull();
    expect(await findingEligibleAt('test-elig-bf')).not.toBeNull();
    const whAfter = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM raw_webhook_events WHERE id = $1`,
      [wh.id],
    );
    expect(whAfter.rows[0]?.retention_eligible_at).not.toBeNull();
    // Raw is intentionally NOT backfilled (post-store eligibility only).
    const rawAfter = await owner.query<{ retention_eligible_at: Date | null }>(
      `SELECT retention_eligible_at FROM raw_transcripts WHERE call_id = $1`,
      ['test-elig-bf'],
    );
    expect(rawAfter.rows[0]?.retention_eligible_at).toBeNull();

    await owner.query(`DELETE FROM raw_webhook_events WHERE id = $1`, [wh.id]);
  });
});
