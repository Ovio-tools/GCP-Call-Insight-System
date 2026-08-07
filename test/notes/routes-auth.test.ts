import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { makeNotesHarness } from './_harness.js';

/**
 * Every route on this surface requires a session. No DB is needed: auth is a `preHandler` installed
 * by `createInternalApp` before any route runs, so an unauthenticated request is refused before the
 * handler could touch the pool. The dummy pool is the proof — if any route reached it, the test
 * would throw rather than 401.
 */
const dummyPool = {} as unknown as Pool;

const HTML_ROUTES = ['/notes', '/notes/call-1'];
const JSON_ROUTES = ['/notes.json', '/notes/call-1.json', '/notes/call-1/transcript.json'];

describe('note-review routes require authentication', () => {
  it('redirects an unauthenticated HTML navigation to the login page', async () => {
    const h = await makeNotesHarness(dummyPool);
    for (const url of HTML_ROUTES) {
      const res = await h.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toMatch(/^\/auth\/login\?returnTo=/);
    }
  });

  it('refuses an unauthenticated JSON/XHR read with AUTH_REQUIRED', async () => {
    const h = await makeNotesHarness(dummyPool);
    for (const url of JSON_ROUTES) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { accept: 'application/json', 'x-requested-with': 'xhr' },
      });
      expect(res.statusCode, url).toBe(401);
      expect(res.json<{ error: string }>().error, url).toBe('AUTH_REQUIRED');
    }
  });

  it('refuses an unauthenticated feedback POST', async () => {
    const h = await makeNotesHarness(dummyPool);
    const res = await h.app.inject({
      method: 'POST',
      url: '/notes/call-1/feedback',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      payload: JSON.stringify({ field_path: 'occupancy', verdict: 'correct' }),
    });
    // Auth is checked before CSRF here, but either refusal is acceptable — what must never happen
    // is a 2xx, or the handler reaching the (dummy) pool.
    expect([401, 403]).toContain(res.statusCode);
    expect(res.json<{ error: string }>().error).toMatch(/AUTH_REQUIRED|CSRF_TOKEN_INVALID/);
  });

  it('leaks nothing about which calls exist in an unauthenticated response', async () => {
    const h = await makeNotesHarness(dummyPool);
    const known = await h.app.inject({
      method: 'GET',
      url: '/notes/call-1/transcript.json',
      headers: { accept: 'application/json', 'x-requested-with': 'xhr' },
    });
    const unknown = await h.app.inject({
      method: 'GET',
      url: '/notes/definitely-not-a-call/transcript.json',
      headers: { accept: 'application/json', 'x-requested-with': 'xhr' },
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    // request_id differs per request; the rest of the shape must not.
    const shape = (body: string): string =>
      body.replace(/"request_id":"[^"]*"/, '"request_id":"…"');
    expect(shape(known.body)).toBe(shape(unknown.body));
  });
});
