import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  acknowledgeAlertsForCompletedCalls,
  acknowledgeStalledAlertsForTerminalReviews,
  countAlertsForCompletedCallsOpen,
  countTerminalReviewStalledOpen,
} from '../../src/db/repositories/alert-events-repo.js';
import { reviewStalledDedupKey } from '../../src/review-queue/sla.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

const PATTERN = 'test-slabf-%';

/**
 * The one-off backfill that retroactively applies the resolve-clears-the-alert rule: it
 * acknowledges a still-open `REVIEW_QUEUE_STALLED` alert only when its review item is already
 * terminal, and leaves a genuinely-open item's alert alone.
 */
describe.skipIf(!hasTestDb)(
  'acknowledgeStalledAlertsForTerminalReviews (SLA-alert backfill)',
  () => {
    let owner!: Pool;
    beforeAll(async () => {
      await migrate('up');
      owner = makePool();
    });
    afterEach(async () => {
      await owner.query(
        `DELETE FROM alert_events WHERE dedup_key IN
         (SELECT 'REVIEW_QUEUE_STALLED:review_queue:' || id FROM review_queue WHERE call_id LIKE $1)
         OR failure_snapshot -> 'context' ->> 'call_id' LIKE $1`,
        [PATTERN],
      );
      await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [PATTERN]);
      await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [PATTERN]);
    });
    afterAll(() => owner.end());

    /** Seed a review in a given status + (optionally) its stalled alert; returns the review id. */
    async function seed(
      callId: string,
      status: string,
      opts: { withAlert?: boolean; alertAcked?: boolean } = {},
    ): Promise<string> {
      await owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held')
       ON CONFLICT (call_id) DO NOTHING`,
        [callId],
      );
      const rq = await owner.query<{ id: string }>(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
       VALUES ($1, 'classified_spam', $2, now()) RETURNING id`,
        [callId, status],
      );
      const reviewId = rq.rows[0]!.id;
      if (opts.withAlert) {
        await owner.query(
          `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, acknowledged_at)
         VALUES ('REVIEW_QUEUE_STALLED', 'REVIEW_QUEUE_STALLED', 'medium', $1, $2)`,
          [reviewStalledDedupKey(reviewId), opts.alertAcked ? new Date() : null],
        );
      }
      return reviewId;
    }

    const isAcked = async (reviewId: string): Promise<boolean | undefined> =>
      (
        await owner.query<{ acked: boolean }>(
          `SELECT acknowledged_at IS NOT NULL AS acked FROM alert_events WHERE dedup_key = $1`,
          [reviewStalledDedupKey(reviewId)],
        )
      ).rows[0]?.acked;

    it('acknowledges alerts for terminal reviews, leaves open reviews and non-stalled alerts alone', async () => {
      const resolved = await seed('test-slabf-resolved', 'resolved', { withAlert: true });
      const unresolvable = await seed('test-slabf-unresolvable', 'unresolvable', {
        withAlert: true,
      });
      const open = await seed('test-slabf-open', 'open', { withAlert: true });
      const already = await seed('test-slabf-already', 'resolved', {
        withAlert: true,
        alertAcked: true,
      });

      // Dry-run count sees only the two still-open alerts on terminal reviews.
      expect(await countTerminalReviewStalledOpen(owner)).toBe(2);

      const n = await acknowledgeStalledAlertsForTerminalReviews(owner);
      expect(n).toBe(2);

      expect(await isAcked(resolved)).toBe(true);
      expect(await isAcked(unresolvable)).toBe(true);
      expect(await isAcked(open)).toBe(false); // genuinely still stalled — untouched
      expect(await isAcked(already)).toBe(true); // was already acked; not double-counted

      // Idempotent: a second run finds nothing left to do.
      expect(await countTerminalReviewStalledOpen(owner)).toBe(0);
      expect(await acknowledgeStalledAlertsForTerminalReviews(owner)).toBe(0);
    });
  },
);

/**
 * The completed-call backfill: acknowledge any still-open alert whose call has since reached
 * `completed`, and leave a not-yet-completed call's alert alone.
 */
describe.skipIf(!hasTestDb)('acknowledgeAlertsForCompletedCalls (completed-call backfill)', () => {
  let owner!: Pool;
  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  afterEach(async () => {
    await owner.query(
      `DELETE FROM alert_events WHERE failure_snapshot -> 'context' ->> 'call_id' LIKE $1`,
      [PATTERN],
    );
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [PATTERN]);
  });
  afterAll(() => owner.end());

  async function seedCallWithAlert(callId: string, status: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'extract', $2) ON CONFLICT (call_id) DO NOTHING`,
      [callId, status],
    );
    await owner.query(
      `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, failure_snapshot)
       VALUES ('REDACTION_LOW_CONFIDENCE', 'REDACTION_LOW_CONFIDENCE', 'medium', $1, $2::jsonb)`,
      [`REDACTION_LOW_CONFIDENCE:${callId}`, JSON.stringify({ context: { call_id: callId } })],
    );
  }
  const isAcked = async (callId: string): Promise<boolean | undefined> =>
    (
      await owner.query<{ acked: boolean }>(
        `SELECT acknowledged_at IS NOT NULL AS acked FROM alert_events
          WHERE failure_snapshot -> 'context' ->> 'call_id' = $1`,
        [callId],
      )
    ).rows[0]?.acked;

  it('acknowledges alerts for completed calls, leaves held/processing calls alone', async () => {
    await seedCallWithAlert('test-slabf-cc-done', 'completed');
    await seedCallWithAlert('test-slabf-cc-held', 'held');

    expect(await countAlertsForCompletedCallsOpen(owner)).toBe(1);
    expect(await acknowledgeAlertsForCompletedCalls(owner)).toBe(1);

    expect(await isAcked('test-slabf-cc-done')).toBe(true);
    expect(await isAcked('test-slabf-cc-held')).toBe(false); // call not done — alert may be live

    // Idempotent.
    expect(await countAlertsForCompletedCallsOpen(owner)).toBe(0);
    expect(await acknowledgeAlertsForCompletedCalls(owner)).toBe(0);
  });
});
