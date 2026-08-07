import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { registerConsoleHomeRoute } from '../../src/console/routes.js';
import { registerStatusRoutes } from '../../src/status/routes.js';
import { registerKnowledgeRoutes } from '../../src/knowledge/routes.js';
import { registerReviewRoutes } from '../../src/review/routes.js';
import { registerNotesRoutes } from '../../src/notes/routes.js';
import { makeInternalApp, login, cookieHeader, sessionCookieValue } from '../http/_helpers.js';
import { makeTestConfig } from '../_config.js';

/**
 * The combined console mounts every internal surface on ONE app behind ONE login, plus a `/` home
 * page. These tests assert (a) the home page's auth behavior and post-login landing, and (b) that
 * status + knowledge + review route modules coexist on a single app with no route collision — the
 * whole premise of the single-entry-point service.
 */
describe('console home route — auth + landing', () => {
  it('bounces an unauthenticated browser navigation to the login page', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const res = await h.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/auth/login?returnTo=${encodeURIComponent('/')}`);
  });

  it('returns 401 to an unauthenticated API/XHR caller (no HTML accept)', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
    const body: { error: string } = res.json();
    expect(body.error).toBe('AUTH_REQUIRED');
  });

  it('serves the home page HTML once authenticated', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const session = await login(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: session.cookie, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('href="/status"');
    expect(res.body).toContain('href="/review"');
  });

  it('nonce-gates the inline script: CSP script-src nonce matches the <script> tag', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const session = await login(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: session.cookie, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy'] ?? '');
    const headerNonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1];
    expect(headerNonce, `no script nonce in CSP: ${csp}`).toBeTruthy();
    // The SAME nonce must be stamped on the inline <script>, or the browser blocks it.
    expect(res.body).toContain(`<script nonce="${headerNonce}">`);
    // style-src must keep 'unsafe-inline' so the inline <style> is not collateral damage.
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it('gives each request a distinct nonce', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const session = await login(h);
    const nonceOf = async (): Promise<string | undefined> => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/',
        headers: { cookie: session.cookie, accept: 'text/html' },
      });
      return /script-src[^;]*'nonce-([^']+)'/.exec(
        String(res.headers['content-security-policy'] ?? ''),
      )?.[1];
    };
    const [a, b] = [await nonceOf(), await nonceOf()];
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('lands a freshly signed-in user on the home page (/)', async () => {
    const h = await makeInternalApp({}, undefined, registerConsoleHomeRoute, {
      loginSuccessRedirect: '/',
    });
    const r1 = await h.app.inject({ method: 'GET', url: '/auth/login' });
    const r2 = await h.app.inject({
      method: 'GET',
      url: '/auth/callback?code=good',
      headers: { cookie: cookieHeader(r1) },
    });
    expect(r2.statusCode).toBe(302);
    expect(r2.headers.location).toBe('/');
    expect(sessionCookieValue(r2)).toBeTruthy();
  });
});

describe('console composition — all surfaces coexist on one app', () => {
  // Registration defines routes and may build schemas from `config`, but never runs a handler here,
  // so a real config plus stubbed pools/queue/etc. suffices to prove the paths coexist without a
  // duplicate-route collision. A stub cast keeps the test independent of each surface's DB wiring.
  const config = makeTestConfig();
  const silent = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;
  const stub = (extra: Record<string, unknown>): never =>
    ({ pool: {}, config, logger: silent, denyTerms: [], ...extra }) as unknown as never;
  const mountAll = (app: FastifyInstance): void => {
    registerConsoleHomeRoute(app);
    registerStatusRoutes(app, stub({}));
    registerKnowledgeRoutes(app, stub({}));
    registerReviewRoutes(app, stub({ rawPool: {}, keyProvider: {}, runner: {}, queue: {} }));
    registerNotesRoutes(app, stub({}));
  };

  it('registers every surface path on one app with no route collision', async () => {
    // If any two modules declared the same route, Fastify throws at registration inside
    // makeInternalApp — so building the app at all is the core collision proof. hasRoute then
    // confirms each surface's route is actually present in the single combined router.
    const h = await makeInternalApp({}, undefined, mountAll, { loginSuccessRedirect: '/' });

    const registered: { method: 'GET' | 'POST'; url: string }[] = [
      { method: 'GET', url: '/' },
      { method: 'GET', url: '/status' },
      { method: 'GET', url: '/calls' },
      { method: 'GET', url: '/knowledge' },
      { method: 'GET', url: '/knowledge/export.csv' },
      { method: 'GET', url: '/review' },
      { method: 'GET', url: '/review/:id' },
      { method: 'POST', url: '/review/:id/reveal-raw' },
      { method: 'GET', url: '/notes' },
      { method: 'GET', url: '/notes.json' },
      { method: 'GET', url: '/notes/:callId' },
      { method: 'GET', url: '/notes/:callId.json' },
      { method: 'GET', url: '/notes/:callId/transcript.json' },
      { method: 'POST', url: '/notes/:callId/feedback' },
    ];
    for (const route of registered) {
      expect(h.app.hasRoute(route), `expected ${route.method} ${route.url}`).toBe(true);
    }
    // A path no surface declares is absent from the combined router.
    expect(h.app.hasRoute({ method: 'GET', url: '/definitely-not-a-route' })).toBe(false);
  });
});
