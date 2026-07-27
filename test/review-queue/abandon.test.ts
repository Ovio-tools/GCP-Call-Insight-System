import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { abandonUnfixableTranscriptHolds } from '../../src/review-queue/abandon.js';
import { reviewStalledDedupKey } from '../../src/review-queue/sla.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';

const PATTERN = 'test-abandon-%';
// 24 h abandon window, well beyond the 30 min transcript wait (the config refinement requires it).
const config = makeTestConfig({ TRANSCRIPT_ABANDON_AFTER_MS: 86_400_000 });
const NOW = new Date('2026-07-27T12:00:00.000Z');

/** A probe that always reports "still nothing at Dialpad" — the observed real-world case. */
const stillMissing = (): Promise<boolean> => Promise.resolve(false);

describe.skipIf(!hasTestDb)('abandonUnfixableTranscriptHolds', () => {
  let owner!: Pool;
  let app!: Pool;
  /** Info-level logger capturing raw JSON lines, so the no-PII assertion sees everything. */
  function capturing(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    return {
      logger: createRootLogger({
        level: 'info',
        name: 'test-abandon',
        destination: { write: (chunk: string) => lines.push(chunk) },
      }),
      lines,
    };
  }
  const { logger } = capturing();

  /**
   * Seed a held call + one active `missing_transcript` review created `hoursAgo` before NOW.
   * Returns the review id.
   */
  async function seedHold(
    callId: string,
    opts: { hoursAgo?: number; reason?: string; status?: string; assignee?: string | null } = {},
  ): Promise<string> {
    const { hoursAgo = 48, reason = 'missing_transcript', status = 'open', assignee = null } = opts;
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'fetch-transcript', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, status, assignee, created_at, sla_due_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz - ($6 * interval '1 hour'),
               $5::timestamptz - ($6 * interval '1 hour') + interval '4 hours')
       RETURNING id`,
      [callId, reason, status, assignee, NOW, hoursAgo],
    );
    return rows[0]!.id;
  }

  const reviewStatus = async (id: string): Promise<string | undefined> =>
    (await owner.query<{ status: string }>(`SELECT status FROM review_queue WHERE id = $1`, [id]))
      .rows[0]?.status;

  const callStatus = async (callId: string): Promise<string | undefined> =>
    (
      await owner.query<{ status: string }>(`SELECT status FROM call_state WHERE call_id = $1`, [
        callId,
      ])
    ).rows[0]?.status;

  /** Record an open alert carrying `call_id` in its sanitized context, as the real paths do. */
  async function seedAlert(errorCode: string, dedupKey: string, callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, failure_snapshot)
       VALUES ($1, $1, 'low', $2, jsonb_build_object('context', jsonb_build_object('call_id', $3::text)))`,
      [errorCode, dedupKey, callId],
    );
  }

  const openAlerts = async (callId: string): Promise<number> =>
    Number(
      (
        await owner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM alert_events
            WHERE acknowledged_at IS NULL
              AND failure_snapshot -> 'context' ->> 'call_id' = $1`,
          [callId],
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await owner.query(`DELETE FROM alert_events WHERE dedup_key LIKE 'test-abandon%'`);
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('closes an aged hold whose transcript is still missing, and clears its alerts', async () => {
    const callId = 'test-abandon-closed';
    const reviewId = await seedHold(callId);
    await seedAlert('DIALPAD_TRANSCRIPT_MISSING', `test-abandon-missing:${callId}`, callId);
    await seedAlert('REVIEW_QUEUE_STALLED', reviewStalledDedupKey(reviewId), callId);
    expect(await openAlerts(callId)).toBe(2);

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(result).toEqual({ closed: 1, recovered: 0, skipped: 0, failed: 0 });
    expect(await reviewStatus(reviewId)).toBe('unresolvable');
    expect(await callStatus(callId)).toBe('review_closed');
    // Both the transcript-missing alert AND the stalled-review alert stop nagging.
    expect(await openAlerts(callId)).toBe(0);
  });

  it('writes exactly one mark_unresolvable audit row naming the system actor', async () => {
    const callId = 'test-abandon-audit';
    const reviewId = await seedHold(callId);

    await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    const { rows } = await owner.query<{ actor: string; action: string }>(
      `SELECT actor, action FROM operator_actions WHERE review_queue_id = $1`,
      [reviewId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('mark_unresolvable');
    expect(rows[0]?.actor).toMatch(/^system:/);
  });

  it('leaves a hold younger than the abandon window alone', async () => {
    const callId = 'test-abandon-young';
    const reviewId = await seedHold(callId, { hoursAgo: 2 });

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(result.closed).toBe(0);
    expect(await reviewStatus(reviewId)).toBe('open');
  });

  it('never touches a hold held for any other reason', async () => {
    const callId = 'test-abandon-otherreason';
    const reviewId = await seedHold(callId, { reason: 'redaction_failed' });

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(result.closed).toBe(0);
    expect(await reviewStatus(reviewId)).toBe('open');
  });

  it('leaves a hold a person has claimed (assigned, or already in review)', async () => {
    const assigned = 'test-abandon-assigned';
    const inReview = 'test-abandon-inreview';
    const assignedId = await seedHold(assigned, { assignee: 'ops@example.com' });
    const inReviewId = await seedHold(inReview, { status: 'in_review' });

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(result.closed).toBe(0);
    expect(await reviewStatus(assignedId)).toBe('open');
    expect(await reviewStatus(inReviewId)).toBe('in_review');
  });

  it('does NOT close a hold whose transcript has since appeared — it leaves it for a person', async () => {
    const callId = 'test-abandon-recovered';
    const reviewId = await seedHold(callId);

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: () => Promise.resolve(true),
    });

    expect(result).toEqual({ closed: 0, recovered: 1, skipped: 0, failed: 0 });
    expect(await reviewStatus(reviewId)).toBe('open');
    expect(await callStatus(callId)).toBe('held');
  });

  it('counts a probe failure as failed, closes nothing, and keeps going', async () => {
    const bad = 'test-abandon-probefail';
    const good = 'test-abandon-probeok';
    const badId = await seedHold(bad);
    const goodId = await seedHold(good);

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: (callId) =>
        callId === bad ? Promise.reject(new Error('dialpad down')) : Promise.resolve(false),
    });

    expect(result.failed).toBe(1);
    expect(result.closed).toBe(1);
    expect(await reviewStatus(badId)).toBe('open');
    expect(await reviewStatus(goodId)).toBe('unresolvable');
  });

  it('is a no-op when the kill switch is off', async () => {
    const callId = 'test-abandon-disabled';
    const reviewId = await seedHold(callId);

    const result = await abandonUnfixableTranscriptHolds(
      app,
      makeTestConfig({
        TRANSCRIPT_ABANDON_ENABLED: false,
        TRANSCRIPT_ABANDON_AFTER_MS: 86_400_000,
      }),
      logger,
      NOW,
      {
        isTranscriptReady: () => {
          throw new Error('probe must not run while disabled');
        },
      },
    );

    expect(result).toEqual({ closed: 0, recovered: 0, skipped: 0, failed: 0 });
    expect(await reviewStatus(reviewId)).toBe('open');
  });

  it('drains more rows than one batch and terminates', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedHold(`test-abandon-batch-${i}`));

    const result = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
      batchSize: 2,
    });

    expect(result.closed).toBe(5);
    for (const id of ids) expect(await reviewStatus(id)).toBe('unresolvable');
  });

  it('is idempotent — a second run finds nothing left to close', async () => {
    const callId = 'test-abandon-twice';
    await seedHold(callId);

    const first = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });
    const second = await abandonUnfixableTranscriptHolds(app, config, logger, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(first.closed).toBe(1);
    expect(second).toEqual({ closed: 0, recovered: 0, skipped: 0, failed: 0 });
  });

  it('logs the closure with a call_id but never a content-shaped field', async () => {
    const { logger: log, lines } = capturing();
    const callId = 'test-abandon-log';
    await seedHold(callId);

    await abandonUnfixableTranscriptHolds(app, config, log, NOW, {
      isTranscriptReady: stillMissing,
    });

    expect(lines.join('\n')).toContain(callId);
    for (const line of lines) {
      expect(line).not.toMatch(/transcript_text|customer_language|"content"/);
    }
  });
});
