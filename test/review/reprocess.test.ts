import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postAction, type ReviewHarness } from './_harness.js';
import { drainPendingReprocessRequests } from '../../src/reconciliation/reprocess-drain.js';

const PATTERN = 'test-rvrep-%';

describe.skipIf(!hasTestDb)('reprocess + approve + preflight (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const callState = async (callId: string) =>
    (
      await h.owner.query<{ status: string; current_stage: string }>(
        `SELECT status, current_stage FROM call_state WHERE call_id=$1`,
        [callId],
      )
    ).rows[0];

  async function seedCandidate(callId: string): Promise<void> {
    await h.owner.query(
      `INSERT INTO extraction_candidates (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id)
       VALUES ($1,'general','other','routine','neutral',1,'v1','m1')
       ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  it('reprocess(fetch-transcript) succeeds within cap even with NO transcript (window-only gate)', async () => {
    const callId = 'test-rvrep-fetch';
    const reviewId = await h.seedHeld(callId, {
      reason: 'missing_transcript',
      stage: 'fetch-transcript',
    });
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'reprocess', { stage: 'fetch-transcript' });
    expect(res.status).toBe(200);
    expect(await callState(callId)).toMatchObject({
      status: 'processing',
      current_stage: 'fetch-transcript',
    });
  });

  it('reprocess(transcript-availability) 409s when no transcript exists', async () => {
    const callId = 'test-rvrep-avail';
    const reviewId = await h.seedHeld(callId, {
      reason: 'missing_transcript',
      stage: 'transcript-availability',
    });
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'reprocess', {
      stage: 'transcript-availability',
    });
    expect(res.status).toBe(409);
  });

  it('a past-cap review (raw_purged_at NULL) 409s even for fetch-transcript', async () => {
    const callId = 'test-rvrep-pastcap';
    const reviewId = await h.seedHeld(callId, {
      reason: 'missing_transcript',
      stage: 'fetch-transcript',
      createdAt: new Date('2026-07-01T00:00:00Z'), // > 24h before now (2026-07-03T12:00)
    });
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'reprocess', { stage: 'fetch-transcript' });
    expect(res.status).toBe(409);
  });

  it('reprocess(redact) 409s when raw is purged; succeeds with a live transcript', async () => {
    const purgedCall = 'test-rvrep-redact-purged';
    const purgedReview = await h.seedHeld(purgedCall, {
      reason: 'redaction_failed',
      stage: 'redact',
      rawPurgedAt: new Date('2026-07-03T11:00:00Z'),
    });
    const session = await h.login();
    expect(
      (await postAction(h, session, purgedReview, 'reprocess', { stage: 'redact' })).status,
    ).toBe(409);

    const okCall = 'test-rvrep-redact-ok';
    const okReview = await h.seedHeld(okCall, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedRawTranscript(okCall, 'raw text');
    expect((await postAction(h, session, okReview, 'reprocess', { stage: 'redact' })).status).toBe(
      200,
    );
    expect(await callState(okCall)).toMatchObject({
      status: 'processing',
      current_stage: 'redact',
    });
  });

  it('reprocess(extract) 409s without a live clean row; succeeds with one', async () => {
    const noClean = 'test-rvrep-extract-noclean';
    const r1 = await h.seedHeld(noClean, { reason: 'schema_invalid', stage: 'extract' });
    const session = await h.login();
    expect((await postAction(h, session, r1, 'reprocess', { stage: 'extract' })).status).toBe(409);

    const withClean = 'test-rvrep-extract-clean';
    const r2 = await h.seedHeld(withClean, { reason: 'schema_invalid', stage: 'extract' });
    await h.seedCleanTranscript(withClean, 'redacted');
    expect((await postAction(h, session, r2, 'reprocess', { stage: 'extract' })).status).toBe(200);
  });

  it('residual_pii_detected seeded at the extract origin restarts at redact', async () => {
    const callId = 'test-rvrep-residual';
    const reviewId = await h.seedHeld(callId, {
      reason: 'residual_pii_detected',
      stage: 'extract',
    });
    await h.seedRawTranscript(callId, 'raw text'); // redact preflight needs the transcript
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'reprocess', { stage: 'redact' });
    expect(res.status).toBe(200);
    expect(await callState(callId)).toMatchObject({
      status: 'processing',
      current_stage: 'redact',
    });
  });

  it('approve(classifier_uncertain) writes the reviewer customer marker then resumes extract', async () => {
    const callId = 'test-rvrep-approve-classify';
    const reviewId = await h.seedHeld(callId, {
      reason: 'classifier_uncertain',
      stage: 'classify',
    });
    await h.seedCleanTranscript(callId, 'redacted [NAME_1]');
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'approve');
    expect(res.status).toBe(200);
    expect(await callState(callId)).toMatchObject({
      status: 'processing',
      current_stage: 'extract',
    });

    const marker = await h.owner.query<{ bucket: string; source: string }>(
      `SELECT detail->>'bucket' AS bucket, detail->>'source' AS source
         FROM processing_log WHERE call_id=$1 AND stage='classify' AND outcome='completed'`,
      [callId],
    );
    expect(marker.rows[0]).toMatchObject({ bucket: 'customer', source: 'reviewer_approved' });
  });

  it('approve(emergency_review) requires a live candidate; 409 without, 200 with', async () => {
    const noCand = 'test-rvrep-emerg-nocand';
    const r1 = await h.seedHeld(noCand, { reason: 'emergency_review', stage: 'extract' });
    await h.seedCleanTranscript(noCand, 'redacted');
    const session = await h.login();
    expect((await postAction(h, session, r1, 'approve')).status).toBe(409);

    const withCand = 'test-rvrep-emerg-cand';
    const r2 = await h.seedHeld(withCand, { reason: 'emergency_review', stage: 'extract' });
    await h.seedCleanTranscript(withCand, 'redacted');
    await seedCandidate(withCand);
    expect((await postAction(h, session, r2, 'approve')).status).toBe(200);
    expect(await callState(withCand)).toMatchObject({
      status: 'processing',
      current_stage: 'verbatim-pii-scan',
    });
  });

  it('an enqueue failure leaves a pending outbox row that the drain then recovers exactly once', async () => {
    const failing = await makeReviewHarness({}, true); // queue.add rejects
    try {
      await migrate('up');
      const callId = 'test-rvrep-drain';
      const reviewId = await failing.seedHeld(callId, {
        reason: 'redaction_failed',
        stage: 'redact',
      });
      await failing.seedRawTranscript(callId, 'raw');
      const session = await failing.login();

      // The action still SUCCEEDS (durable outbox), but nothing was enqueued.
      expect(
        (await postAction(failing, session, reviewId, 'reprocess', { stage: 'redact' })).status,
      ).toBe(200);
      const pending = await failing.owner.query<{ status: string }>(
        `SELECT status FROM reprocess_requests WHERE call_id=$1`,
        [callId],
      );
      expect(pending.rows[0]!.status).toBe('pending');

      // Drain with a working enqueue → enqueues once and marks sent.
      const enq: string[] = [];
      const result = await drainPendingReprocessRequests(failing.appPool, {
        enqueue: (row) => {
          enq.push(row.callId);
          return Promise.resolve();
        },
      });
      expect(result).toEqual({ enqueued: 1, superseded: 0, failed: 0 });
      expect(enq).toEqual([callId]);
      const after = await failing.owner.query<{ status: string }>(
        `SELECT status FROM reprocess_requests WHERE call_id=$1`,
        [callId],
      );
      expect(after.rows[0]!.status).toBe('sent');
      await failing.cleanup('test-rvrep-drain%');
    } finally {
      await failing.close();
    }
  });
});
