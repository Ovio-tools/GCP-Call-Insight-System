import { describe, expect, it, vi } from 'vitest';
import { makeInternalApp, login, FakeAuthProvider, cookieHeader } from './_helpers.js';

const PII = {
  email: 'jane.doe@example.com',
  phone: '+15551234567',
  transcript: 'the customer said something private',
};

describe('internal app — hardening', () => {
  it('rejects an oversized body with 413 before auth', async () => {
    const { app } = await makeInternalApp({ HTTP_MAX_BODY_BYTES: 100 });
    const res = await app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(1000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'REQUEST_BODY_TOO_LARGE' });
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = await makeInternalApp();
    const res = await app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'REQUEST_MALFORMED' });
  });

  it('rejects an unsupported content type with 415', async () => {
    const { app } = await makeInternalApp();
    // Fastify ships default parsers for application/json and text/plain; use a type with
    // no parser so the media-type guard fires (before auth).
    const res = await app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { 'content-type': 'application/xml' },
      payload: '<a>hello</a>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('trips the per-IP rate limit at the configured threshold', async () => {
    const { app } = await makeInternalApp({ RATE_LIMIT_MAX: 2 });
    const ok1 = await app.inject({ method: 'GET', url: '/health' });
    const ok2 = await app.inject({ method: 'GET', url: '/health' });
    const tripped = await app.inject({ method: 'GET', url: '/health' });
    expect(ok1.statusCode).toBe(200);
    expect(ok2.statusCode).toBe(200);
    expect(tripped.statusCode).toBe(429);
    expect(tripped.json()).toMatchObject({ error: 'RATE_LIMIT_EXCEEDED' });
  });
});

describe('internal app — auth & session', () => {
  it('refuses an unauthenticated request to an internal route', async () => {
    const { app } = await makeInternalApp();
    const res = await app.inject({ method: 'GET', url: '/example/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'AUTH_REQUIRED' });
  });

  it('allows an authenticated request and exposes the identity', async () => {
    const harness = await makeInternalApp();
    const { cookie } = await login(harness);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'user-1', roles: ['reviewer'] });
  });

  it('rotates the session id on login (fixation defense)', async () => {
    const harness = await makeInternalApp();
    const r1 = await harness.app.inject({ method: 'GET', url: '/auth/login' });
    const before = (r1.cookies as { name: string; value: string }[]).find((c) => c.name === 'sid');
    const cookie = (r1.cookies as { name: string; value: string }[])
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const r2 = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?code=good',
      headers: { cookie },
    });
    const after = (r2.cookies as { name: string; value: string }[]).find((c) => c.name === 'sid');

    expect(before?.value).toBeTruthy();
    expect(after?.value).toBeTruthy();
    expect(after?.value).not.toBe(before?.value);
  });

  it('sets hardened cookie flags (HttpOnly, Secure over HTTPS, SameSite=Lax, path-scoped)', async () => {
    // Secure cookies require HTTPS; simulate it via x-forwarded-proto (trustProxy is on).
    const harness = await makeInternalApp({ SESSION_COOKIE_SECURE: true });
    const https = { 'x-forwarded-proto': 'https' };
    const r1 = await harness.app.inject({ method: 'GET', url: '/auth/login', headers: https });
    const setCookie = String(r1.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
  });

  it('sends a post-login returnTo of "/" to the app home, not the route-less root', async () => {
    // A browser opening the bare domain is bounced to login with returnTo=/. After login the
    // callback must NOT drop the user back on "/" (no surface has a root route → NOT_FOUND);
    // it lands them on the configured app home instead.
    const harness = await makeInternalApp({}, new FakeAuthProvider(), undefined, {
      loginSuccessRedirect: '/knowledge',
    });
    const r1 = await harness.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const r2 = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?code=good',
      headers: { cookie: cookieHeader(r1) },
    });
    expect(r2.statusCode).toBeGreaterThanOrEqual(300);
    expect(r2.statusCode).toBeLessThan(400);
    expect(r2.headers.location).toBe('/knowledge');
  });

  it('still honors a real same-origin returnTo sub-path after login', async () => {
    const harness = await makeInternalApp({}, new FakeAuthProvider(), undefined, {
      loginSuccessRedirect: '/knowledge',
    });
    const r1 = await harness.app.inject({
      method: 'GET',
      url: '/auth/login?returnTo=%2Fknowledge%2Fexport.csv',
    });
    const r2 = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?code=good',
      headers: { cookie: cookieHeader(r1) },
    });
    expect(r2.headers.location).toBe('/knowledge/export.csv');
  });

  it('rejects a callback with a failed exchange (bad state/nonce/PKCE)', async () => {
    const harness = await makeInternalApp();
    const r1 = await harness.app.inject({ method: 'GET', url: '/auth/login' });
    const cookie = (r1.cookies as { name: string; value: string }[])
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const r2 = await harness.app.inject({
      method: 'GET',
      url: '/auth/callback?code=bad',
      headers: { cookie },
    });
    expect(r2.statusCode).toBe(401);
    expect(r2.json()).toMatchObject({ error: 'AUTH_REQUIRED' });
  });

  it('destroys the session on logout', async () => {
    const harness = await makeInternalApp();
    const { cookie, csrfToken } = await login(harness);
    const out = await harness.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(out.statusCode).toBeLessThan(400); // redirect
    const after = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('internal app — CSRF', () => {
  it('rejects an unsafe method without a CSRF token', async () => {
    const harness = await makeInternalApp();
    const { cookie } = await login(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'CSRF_TOKEN_INVALID' });
  });

  it('accepts an unsafe method with a valid CSRF token', async () => {
    const harness = await makeInternalApp();
    const { cookie, csrfToken } = await login(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('rejects a mismatched CSRF token', async () => {
    const harness = await makeInternalApp();
    const { cookie } = await login(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { cookie, 'x-csrf-token': 'not-the-real-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('internal app — per-user rate limit', () => {
  it('keeps user buckets independent behind one IP', async () => {
    const provider = new FakeAuthProvider();
    const harness = await makeInternalApp(
      { RATE_LIMIT_MAX: 1000, USER_RATE_LIMIT_MAX: 2 },
      provider,
    );

    provider.user = { id: 'alice', roles: [] };
    const alice = await login(harness, { fetchCsrf: false });
    provider.user = { id: 'bob', roles: [] };
    const bob = await login(harness, { fetchCsrf: false });

    const a1 = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie: alice.cookie },
    });
    const a2 = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie: alice.cookie },
    });
    const a3 = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie: alice.cookie },
    });
    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(200);
    expect(a3.statusCode).toBe(429); // alice's bucket exhausted

    const b1 = await harness.app.inject({
      method: 'GET',
      url: '/example/whoami',
      headers: { cookie: bob.cookie },
    });
    expect(b1.statusCode).toBe(200); // bob's bucket is independent
  });
});

describe('internal app — no PII in responses or logs', () => {
  it('never echoes planted PII, and the error body is a minimal safe shape', async () => {
    const harness = await makeInternalApp();
    const { cookie } = await login(harness);
    // No CSRF token → 403, with PII planted in headers and body.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/example/action',
      headers: { cookie, 'x-customer-email': PII.email },
      payload: { transcript: PII.transcript, customer_phone: PII.phone },
    });
    expect(res.statusCode).toBe(403);

    const raw = res.payload;
    for (const secret of Object.values(PII)) {
      expect(raw).not.toContain(secret);
    }
    // Body carries only the safe projection — no remediation/owner/runbook/context.
    const body: Record<string, unknown> = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'request_id']);
    expect(raw).not.toContain('runbook');
    expect(raw).not.toContain('OVIO');

    // Logs contain none of the planted PII.
    const logText = harness.lines.join('\n');
    for (const secret of Object.values(PII)) {
      expect(logText).not.toContain(secret);
    }
  });

  it('does not run the downstream handler when a request is rejected', async () => {
    const handler = vi.fn(() => ({ ran: true }));
    const harness = await makeInternalApp({}, new FakeAuthProvider(), (app) => {
      app.post('/spy', handler);
    });
    const { cookie } = await login(harness);
    // Missing CSRF token → rejected before the handler.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/spy',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
