import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasRawTestDb, hasTestDb, migrate, migrateRaw } from '../db/_pg.js';
import { makeReviewHarness, type ReviewHarness } from './_harness.js';
import type { ReviewList } from '../../src/review/dto.js';

const PATTERN = 'test-rvlist-%';

const DESC = 'review list — call length';

describe.skipIf(!hasTestDb || !hasRawTestDb)(DESC, () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const getList = async (): Promise<{ status: number; body: ReviewList }> => {
    const session = await h.login();
    const res = await h.app.inject({
      method: 'GET',
      url: '/review.json',
      headers: { cookie: session.cookie },
    });
    return { status: res.statusCode, body: res.json() };
  };

  const durationOf = (body: ReviewList, callId: string): number | null | undefined =>
    body.items.find((i) => i.call_id === callId)?.call_duration_ms;

  it('carries each calls length, and null for a call that never recorded one', async () => {
    await h.seedHeld('test-rvlist-long', {
      reason: 'missing_transcript',
      stage: 'fetch-transcript',
      sourceMetadata: { duration: 222_400 },
    });
    await h.seedHeld('test-rvlist-short', {
      reason: 'missing_transcript',
      stage: 'fetch-transcript',
      sourceMetadata: { duration: 1_500 },
    });
    await h.seedHeld('test-rvlist-unknown', { reason: 'redaction_failed', stage: 'redact' });

    const { status, body } = await getList();

    expect(status).toBe(200);
    expect(durationOf(body, 'test-rvlist-long')).toBe(222_400);
    expect(durationOf(body, 'test-rvlist-short')).toBe(1_500);
    expect(durationOf(body, 'test-rvlist-unknown')).toBeNull();
  });

  it('resolves the whole page with ONE call_state query, never one per row', async () => {
    await h.seedHeld('test-rvlist-n1a', { sourceMetadata: { duration: 1_000 } });
    await h.seedHeld('test-rvlist-n1b', { sourceMetadata: { duration: 2_000 } });
    await h.seedHeld('test-rvlist-n1c', { sourceMetadata: { duration: 3_000 } });

    // Spy on the very pool the routes were registered with, so the count is what the request
    // actually issued. This is the only assertion that fails if the batched reader is ever
    // "simplified" into a per-row getCallState loop — which would also reintroduce the
    // SELECT * over source_metadata that this surface must not do.
    const spy = vi.spyOn(h.appPool, 'query');
    const { body } = await getList();
    const callStateQueries = spy.mock.calls.filter(([text]) =>
      String(text).includes('FROM call_state'),
    );

    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(callStateQueries).toHaveLength(1);
  });
});
