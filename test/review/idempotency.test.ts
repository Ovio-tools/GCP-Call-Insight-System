import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postAction, type ReviewHarness } from './_harness.js';

const PATTERN = 'test-rvidem-%';

describe.skipIf(!hasTestDb)('review action idempotency + terminal guard (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const auditCount = async (id: string): Promise<number> =>
    (
      await h.owner.query<{ c: number }>(
        `SELECT count(*)::int c FROM operator_actions WHERE review_queue_id=$1`,
        [id],
      )
    ).rows[0]!.c;
  const outboxCount = async (callId: string): Promise<number> =>
    (
      await h.owner.query<{ c: number }>(
        `SELECT count(*)::int c FROM reprocess_requests WHERE call_id=$1`,
        [callId],
      )
    ).rows[0]!.c;

  it('duplicate reject → one audit row, second is a 200 no-op', async () => {
    const callId = 'test-rvidem-reject';
    const reviewId = await h.seedHeld(callId, { reason: 'classified_spam', stage: 'classify' });
    const session = await h.login();
    expect((await postAction(h, session, reviewId, 'reject')).status).toBe(200);
    expect((await postAction(h, session, reviewId, 'reject')).status).toBe(200); // no-op
    expect(await auditCount(reviewId)).toBe(1);
  });

  it('reject then mark_spam (different action) → 409', async () => {
    const callId = 'test-rvidem-diffaction';
    const reviewId = await h.seedHeld(callId, { reason: 'classified_spam', stage: 'classify' });
    const session = await h.login();
    expect((await postAction(h, session, reviewId, 'reject')).status).toBe(200);
    expect((await postAction(h, session, reviewId, 'mark_spam')).status).toBe(409);
    expect(await auditCount(reviewId)).toBe(1);
  });

  it('reprocess(classify) then reprocess(extract) → same action, different params → 409; no second outbox', async () => {
    const callId = 'test-rvidem-diffparams';
    const reviewId = await h.seedHeld(callId, {
      reason: 'classifier_uncertain',
      stage: 'classify',
    });
    await h.seedCleanTranscript(callId, 'redacted [NAME_1]');
    const session = await h.login();

    expect(
      (await postAction(h, session, reviewId, 'reprocess', { stage: 'classify' })).status,
    ).toBe(200);
    expect((await postAction(h, session, reviewId, 'reprocess', { stage: 'extract' })).status).toBe(
      409,
    );
    expect(await auditCount(reviewId)).toBe(1);
    expect(await outboxCount(callId)).toBe(1);
  });

  it('duplicate reprocess(classify) → 200 no-op, no second outbox/enqueue', async () => {
    const callId = 'test-rvidem-dupreprocess';
    const reviewId = await h.seedHeld(callId, {
      reason: 'classifier_uncertain',
      stage: 'classify',
    });
    await h.seedCleanTranscript(callId, 'redacted [NAME_1]');
    const session = await h.login();

    expect(
      (await postAction(h, session, reviewId, 'reprocess', { stage: 'classify' })).status,
    ).toBe(200);
    const enqueuedAfterFirst = h.enqueued.length;
    expect(
      (await postAction(h, session, reviewId, 'reprocess', { stage: 'classify' })).status,
    ).toBe(200);
    expect(await auditCount(reviewId)).toBe(1);
    expect(await outboxCount(callId)).toBe(1);
    expect(h.enqueued.length).toBe(enqueuedAfterFirst); // no second enqueue
  });

  it('duplicate mark_unresolvable → exactly one audit row (no double write)', async () => {
    const callId = 'test-rvidem-unres';
    const reviewId = await h.seedHeld(callId, {
      reason: 'weak_servicetitan_match',
      stage: 'extract',
    });
    const session = await h.login();
    expect((await postAction(h, session, reviewId, 'mark_unresolvable')).status).toBe(200);
    expect((await postAction(h, session, reviewId, 'mark_unresolvable')).status).toBe(200); // no-op
    expect(await auditCount(reviewId)).toBe(1);
  });

  it('terminal guard: a review whose call_state is already completed → 409, no writes', async () => {
    const callId = 'test-rvidem-completed';
    const reviewId = await h.seedHeld(callId, { reason: 'schema_invalid', stage: 'extract' });
    // Corrupt: call_state advanced to completed while the review is still open.
    await h.owner.query(
      `UPDATE call_state SET status='completed', current_stage='mark-retention-eligible' WHERE call_id=$1`,
      [callId],
    );
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'reject');
    expect(res.status).toBe(409);
    expect(await auditCount(reviewId)).toBe(0);
  });

  it('mark_unresolvable against a STALE review id closes neither row (409)', async () => {
    const callId = 'test-rvidem-stale';
    const reviewA = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    const session = await h.login();
    // Resolve review A (reject), then make a NEW active review B for the same call.
    expect((await postAction(h, session, reviewA, 'reject')).status).toBe(200);
    await h.owner.query(`UPDATE call_state SET status='held', drop_reason=NULL WHERE call_id=$1`, [
      callId,
    ]);
    const reviewB = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });

    // Acting on the STALE review A must not touch review B.
    const res = await postAction(h, session, reviewA, 'mark_unresolvable');
    expect(res.status).toBe(409);
    const bStatus = (
      await h.owner.query<{ status: string }>(`SELECT status FROM review_queue WHERE id=$1`, [
        reviewB,
      ])
    ).rows[0]!.status;
    expect(bStatus).toBe('open'); // review B untouched
  });
});
