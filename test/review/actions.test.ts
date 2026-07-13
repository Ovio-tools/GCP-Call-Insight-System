import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postAction, type ReviewHarness } from './_harness.js';
import {
  HUMAN_REVIEW_MODEL_ID,
  HUMAN_REVIEW_PROBLEM_STATEMENT,
  HUMAN_REVIEW_PROMPT_VERSION,
} from '../../src/review/correction-constants.js';
import { EXTRACT_SCHEMA_VERSION } from '../../src/pipeline/extract/prompt.js';
import { reviewStalledDedupKey } from '../../src/review-queue/sla.js';

const PATTERN = 'test-rvact-%';

describe.skipIf(!hasTestDb)('review actions (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const callState = async (callId: string) =>
    (
      await h.owner.query<{ status: string; current_stage: string; drop_reason: string | null }>(
        `SELECT status, current_stage, drop_reason FROM call_state WHERE call_id = $1`,
        [callId],
      )
    ).rows[0];
  const reviewRow = async (id: string) =>
    (await h.owner.query<{ status: string }>(`SELECT status FROM review_queue WHERE id = $1`, [id]))
      .rows[0];
  const audits = async (id: string) =>
    (
      await h.owner.query<{ action: string; before: unknown; after: unknown }>(
        `SELECT action, before, after FROM operator_actions WHERE review_queue_id = $1 ORDER BY created_at`,
        [id],
      )
    ).rows;

  it('mark_non_customer → skipped@classify + drop_reason, review resolved, one audit row', async () => {
    const callId = 'test-rvact-noncust';
    const reviewId = await h.seedHeld(callId, { reason: 'schema_invalid', stage: 'extract' });
    const session = await h.login();

    const res = await postAction(h, session, reviewId, 'mark_non_customer');
    expect(res.status).toBe(200);

    const cs = await callState(callId);
    expect(cs).toMatchObject({
      status: 'skipped',
      current_stage: 'classify',
      drop_reason: 'classified_non_customer',
    });
    expect((await reviewRow(reviewId))!.status).toBe('resolved');
    const a = await audits(reviewId);
    expect(a).toHaveLength(1);
    expect(a[0]!.action).toBe('mark_non_customer');
    expect(a[0]!.after).toMatchObject({ action_params: {} });
  });

  // A stalled-review alert for `reviewId`, matching what scanStalledReviews would have raised.
  const seedStalledAlert = async (reviewId: string) =>
    h.owner.query(
      `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key)
       VALUES ('REVIEW_QUEUE_STALLED', 'REVIEW_QUEUE_STALLED', 'medium', $1)`,
      [reviewStalledDedupKey(reviewId)],
    );
  const alertAcknowledged = async (reviewId: string) =>
    (
      await h.owner.query<{ acked: boolean }>(
        `SELECT acknowledged_at IS NOT NULL AS acked FROM alert_events WHERE dedup_key = $1`,
        [reviewStalledDedupKey(reviewId)],
      )
    ).rows[0]?.acked;

  it('resolving a held call acknowledges its REVIEW_QUEUE_STALLED alert (clears the banner)', async () => {
    const callId = 'test-rvact-slaclear';
    const reviewId = await h.seedHeld(callId, { reason: 'classified_spam', stage: 'classify' });
    await seedStalledAlert(reviewId);
    expect(await alertAcknowledged(reviewId)).toBe(false);

    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'mark_spam');
    expect(res.status).toBe(200);
    expect((await reviewRow(reviewId))!.status).toBe('resolved');
    // The stalled alert is now acknowledged, so the status-page banner stops lingering.
    expect(await alertAcknowledged(reviewId)).toBe(true);
  });

  it('a 409 (no resolution) leaves the stalled alert unacknowledged', async () => {
    const callId = 'test-rvact-slanoack';
    // approve is disallowed for redaction_failed → 409, tx rolls back.
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    await seedStalledAlert(reviewId);
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'approve');
    expect(res.status).toBe(409);
    expect(await alertAcknowledged(reviewId)).toBe(false);
  });

  it('reject and mark_spam both close the review (resolved + review_closed)', async () => {
    for (const action of ['reject', 'mark_spam'] as const) {
      const callId = `test-rvact-${action}`;
      const reviewId = await h.seedHeld(callId, { reason: 'classified_spam', stage: 'classify' });
      const session = await h.login();
      const res = await postAction(h, session, reviewId, action);
      expect(res.status).toBe(200);
      expect((await callState(callId))!.status).toBe('review_closed');
      expect((await reviewRow(reviewId))!.status).toBe('resolved');
    }
  });

  it('a disallowed action → 409, no write', async () => {
    const callId = 'test-rvact-disallowed';
    // approve is NOT allowed for redaction_failed.
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'approve');
    expect(res.status).toBe(409);
    // Nothing changed.
    expect((await callState(callId))!.status).toBe('held');
    expect((await reviewRow(reviewId))!.status).toBe('open');
    expect(await audits(reviewId)).toHaveLength(0);
  });

  it('correct_extraction (schema_invalid) forces provenance constants, reprocesses, and writes the outbox', async () => {
    const callId = 'test-rvact-correct';
    const reviewId = await h.seedHeld(callId, { reason: 'schema_invalid', stage: 'extract' });
    await h.seedCleanTranscript(callId, 'redacted text only [NAME_1]');
    const session = await h.login();

    const res = await postAction(h, session, reviewId, 'correct_extraction', {
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
    });
    expect(res.status).toBe(200);

    // Call re-enters at verbatim-pii-scan; review resolved.
    expect(await callState(callId)).toMatchObject({
      status: 'processing',
      current_stage: 'verbatim-pii-scan',
    });
    expect((await reviewRow(reviewId))!.status).toBe('resolved');

    // Candidate written with HUMAN_REVIEW provenance + forced constants.
    const cand = (
      await h.owner.query<{
        problem_statement: string;
        customer_language: unknown;
        prompt_version: string;
        model_id: string;
        schema_version: number;
        call_intent: string;
      }>(
        `SELECT problem_statement, customer_language, prompt_version, model_id, schema_version, call_intent FROM extraction_candidates WHERE call_id = $1`,
        [callId],
      )
    ).rows[0]!;
    expect(cand.problem_statement).toBe(HUMAN_REVIEW_PROBLEM_STATEMENT);
    expect(cand.customer_language).toEqual([]);
    expect(cand.prompt_version).toBe(HUMAN_REVIEW_PROMPT_VERSION);
    expect(cand.model_id).toBe(HUMAN_REVIEW_MODEL_ID);
    expect(cand.schema_version).toBe(EXTRACT_SCHEMA_VERSION);
    expect(cand.call_intent).toBe('new_booking');

    // Audit fingerprint + outbox row + enqueue.
    const a = await audits(reviewId);
    expect(a[0]!.after).toMatchObject({
      action_params: {
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'routine',
        sentiment: 'neutral',
        target_stage: 'verbatim-pii-scan',
      },
    });
    const outbox = await h.owner.query(`SELECT status FROM reprocess_requests WHERE call_id = $1`, [
      callId,
    ]);
    expect(outbox.rows).toHaveLength(1);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.data).toEqual({ callId });
  });

  it('correct_extraction rejects reviewer free text (400)', async () => {
    const callId = 'test-rvact-correct-freetext';
    const reviewId = await h.seedHeld(callId, { reason: 'schema_invalid', stage: 'extract' });
    await h.seedCleanTranscript(callId, 'redacted');
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'correct_extraction', {
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
      problem_statement: 'leaking pipe at 123 Main St',
    });
    expect(res.status).toBe(400);
    // No candidate created, review untouched.
    expect((await reviewRow(reviewId))!.status).toBe('open');
  });

  it('correct_extraction 409s when the clean transcript is missing', async () => {
    const callId = 'test-rvact-correct-noclean';
    const reviewId = await h.seedHeld(callId, { reason: 'schema_invalid', stage: 'extract' });
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'correct_extraction', {
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
    });
    expect(res.status).toBe(409);
    expect((await reviewRow(reviewId))!.status).toBe('open');
  });
});
