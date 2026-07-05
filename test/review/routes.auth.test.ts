import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postAction, type ReviewHarness } from './_harness.js';

const PATTERN = 'test-rvauth-%';

describe.skipIf(!hasTestDb)('review routes — auth & hardening (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  it('rejects unauthenticated access to every route (401)', async () => {
    const paths: [string, string][] = [
      ['GET', '/review'],
      ['GET', '/review.json'],
      ['GET', '/review/some-id'],
      ['GET', '/review/some-id.json'],
      ['POST', '/review/some-id/actions/reject'],
      ['POST', '/review/some-id/reveal-raw'],
    ];
    for (const [method, url] of paths) {
      const res = await h.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      const body: { error: string; message: string; request_id: string } = res.json();
      expect(body.error).toBe('AUTH_REQUIRED');
      expect(body.request_id).toBeTruthy();
    }
  });

  it('list + detail are reachable once authenticated', async () => {
    const session = await h.login();
    const list = await h.app.inject({
      method: 'GET',
      url: '/review.json',
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(200);
    const listBody: { items: unknown[] } = list.json();
    expect(listBody.items).toBeInstanceOf(Array);
  });

  it('POST without CSRF → 403; with the header → not a CSRF failure', async () => {
    const reviewId = await h.seedHeld('test-rvauth-csrf');
    const session = await h.login();
    // No CSRF header.
    const noCsrf = await h.app.inject({
      method: 'POST',
      url: `/review/${reviewId}/actions/reject`,
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noCsrf.statusCode).toBe(403);
    const csrfBody: { error: string } = noCsrf.json();
    expect(csrfBody.error).toBe('CSRF_TOKEN_INVALID');
    // With CSRF header → succeeds.
    const ok = await postAction(h, session, reviewId, 'reject');
    expect(ok.status).toBe(200);
  });

  it('an unknown :action → REQUEST_MALFORMED (400), not a framework 404', async () => {
    const reviewId = await h.seedHeld('test-rvauth-badaction');
    const session = await h.login();
    const res = await postAction(h, session, reviewId, 'frobnicate');
    expect(res.status).toBe(400);
    expect((res.json() as { error: string }).error).toBe('REQUEST_MALFORMED');
  });

  it('a malformed JSON body on an action → 400', async () => {
    const reviewId = await h.seedHeld('test-rvauth-badbody');
    const session = await h.login();
    const res = await h.app.inject({
      method: 'POST',
      url: `/review/${reviewId}/actions/reject`,
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
  });
});
