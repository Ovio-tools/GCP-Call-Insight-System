import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasRawTestDb, hasTestDb, migrate, migrateRaw } from '../db/_pg.js';
import { makeReviewHarness, type ReviewHarness } from './_harness.js';
import type { ReviewDetail } from '../../src/review/dto.js';

const PATTERN = 'test-rvdet-%';

const DESC = 'review detail content + raw availability (Task 6.2)';

describe.skipIf(!hasTestDb || !hasRawTestDb)(DESC, () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const getDetail = async (reviewId: string): Promise<{ status: number; body: ReviewDetail }> => {
    const session = await h.login();
    const res = await h.app.inject({
      method: 'GET',
      url: `/review/${reviewId}.json`,
      headers: { cookie: session.cookie },
    });
    return { status: res.statusCode, body: res.json() };
  };

  it('a redaction hold with no live clean row → content unavailable, actions still listed', async () => {
    const callId = 'test-rvdet-noclean';
    const reviewId = await h.seedHeld(callId, { reason: 'residual_pii_detected', stage: 'redact' });
    const { status, body } = await getDetail(reviewId);
    expect(status).toBe(200);
    expect(body.redacted_content_available).toBe(false);
    expect(body.redacted_content).toBeNull();
    expect(body.redacted_content_withheld_reason).toBe('no_clean_transcript');
    expect(body.allowed_actions).toContain('reject');
  });

  it('a clean row that survives the residual scan is shown', async () => {
    const callId = 'test-rvdet-clean';
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedCleanTranscript(callId, 'Customer [NAME_1] reported an issue near [ADDRESS_1].');
    const { body } = await getDetail(reviewId);
    expect(body.redacted_content_available).toBe(true);
    expect(body.redacted_content).toContain('[NAME_1]');
    expect(body.redacted_content_withheld_reason).toBeNull();
  });

  it('a clean row with residual PII (fake phone) is withheld', async () => {
    const callId = 'test-rvdet-residual';
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedCleanTranscript(callId, 'call me back at 5551234567 tomorrow');
    const { body } = await getDetail(reviewId);
    expect(body.redacted_content_available).toBe(false);
    expect(body.redacted_content).toBeNull();
    expect(body.redacted_content_withheld_reason).toBe('residual_pii');
  });

  it('raw_available is true within cap with a transcript, false when purged', async () => {
    const okCall = 'test-rvdet-rawok';
    const okReview = await h.seedHeld(okCall, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedRawTranscript(okCall, 'raw content');
    expect((await getDetail(okReview)).body.raw_available).toBe(true);

    // Seed the raw transcript while the review is un-purged (Task 8.1's putTranscript guard
    // refuses to write raw for a call whose review already carries raw_purged_at), then stamp the
    // purge flag — proving raw_purged_at overrides a still-present transcript.
    const purgedCall = 'test-rvdet-rawpurged';
    const purgedReview = await h.seedHeld(purgedCall, {
      reason: 'redaction_failed',
      stage: 'redact',
    });
    await h.seedRawTranscript(purgedCall, 'raw content');
    await h.owner.query(`UPDATE review_queue SET raw_purged_at = $2 WHERE id = $1`, [
      purgedReview,
      new Date('2026-07-03T11:00:00Z'),
    ]);
    expect((await getDetail(purgedReview)).body.raw_available).toBe(false);
  });

  it('a past-cap review with raw_purged_at still NULL reports raw_available:false', async () => {
    const callId = 'test-rvdet-pastcap';
    const reviewId = await h.seedHeld(callId, {
      reason: 'redaction_failed',
      stage: 'redact',
      createdAt: new Date('2026-07-01T00:00:00Z'), // > 24h before now
    });
    await h.seedRawTranscript(callId, 'raw content');
    expect((await getDetail(reviewId)).body.raw_available).toBe(false);
  });

  it('404s for an unknown review id', async () => {
    const { status } = await getDetail('00000000-0000-0000-0000-000000000000');
    expect(status).toBe(404);
  });
});
