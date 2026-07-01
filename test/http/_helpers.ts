import type { Logger } from 'pino';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createRootLogger } from '../../src/logging/logger.js';
import type { Config } from '../../src/config/schema.js';
import {
  createInternalApp,
  createWebhookApp,
  MemoryRateStore,
  MemoryReplayStore,
  registerInternalExampleRoutes,
  type AuthProvider,
  type AuthenticatedUser,
  type AuthorizationRequest,
  type CallbackParams,
  type Clock,
} from '../../src/http/index.js';
import { makeTestConfig } from '../_config.js';

/** A controllable clock for freshness/TTL tests. */
export class FakeClock implements Clock {
  constructor(public t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A fake identity provider — no network, deterministic, configurable to fail the callback. */
export class FakeAuthProvider implements AuthProvider {
  user: AuthenticatedUser = { id: 'user-1', roles: ['reviewer'] };
  failCallback = false;
  private n = 0;

  createAuthorizationRequest(): Promise<AuthorizationRequest> {
    this.n += 1;
    return Promise.resolve({
      url: 'https://idp.example/authorize',
      state: `state-${this.n}`,
      nonce: `nonce-${this.n}`,
      codeVerifier: `verifier-${this.n}`,
    });
  }

  exchangeCallback(params: CallbackParams): Promise<AuthenticatedUser> {
    if (this.failCallback || params.callbackUrl.includes('code=bad')) {
      return Promise.reject(new Error('invalid callback'));
    }
    return Promise.resolve({ ...this.user });
  }
}

/** A capturing logger whose lines can be asserted against for PII. */
export function makeCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger({
    level: 'warn',
    name: 'test-http',
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  return { logger, lines };
}

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

export interface InternalHarness {
  app: Awaited<ReturnType<typeof createInternalApp>>;
  provider: FakeAuthProvider;
  logger: Logger;
  lines: string[];
}

/** Build an internal app wired with in-memory fakes and example routes. */
export async function makeInternalApp(
  overrides: Partial<Config> = {},
  provider: FakeAuthProvider = new FakeAuthProvider(),
  extraRoutes?: (app: FastifyInstance) => void,
): Promise<InternalHarness> {
  const config = makeTestConfig({
    SESSION_SECRET,
    // Default false so cookies are set over plain-HTTP `inject` (@fastify/session refuses to
    // set a Secure cookie on a non-HTTPS request). The Secure flag is asserted separately by
    // simulating HTTPS via x-forwarded-proto.
    SESSION_COOKIE_SECURE: false,
    ...overrides,
  });
  const { logger, lines } = makeCapturingLogger();
  const app = await createInternalApp({
    config,
    authProvider: provider,
    rateStore: new MemoryRateStore(),
    logger,
  });
  registerInternalExampleRoutes(app);
  extraRoutes?.(app);
  await app.ready();
  return { app, provider, logger, lines };
}

/** Build a webhook app with in-memory replay/rate stores and a controllable clock. */
export async function makeWebhookApp(
  overrides: Partial<Config> = {},
  clock: FakeClock = new FakeClock(),
): Promise<{
  webhookApp: Awaited<ReturnType<typeof createWebhookApp>>;
  clock: FakeClock;
  logger: Logger;
  lines: string[];
}> {
  const config = makeTestConfig(overrides);
  const { logger, lines } = makeCapturingLogger();
  const webhookApp = await createWebhookApp({
    config,
    replayStore: new MemoryReplayStore(clock),
    rateStore: new MemoryRateStore(clock),
    clock,
    logger,
  });
  return { webhookApp, clock, logger, lines };
}

/** Serialize a response's Set-Cookie(s) into a Cookie request header. */
export function cookieHeader(res: LightMyRequestResponse): string {
  const cookies = res.cookies as { name: string; value: string }[];
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** The named session cookie value from a response, if present. */
export function sessionCookieValue(res: LightMyRequestResponse, name = 'sid'): string | undefined {
  const cookies = res.cookies as { name: string; value: string }[];
  return cookies.find((c) => c.name === name)?.value;
}

export interface LoggedIn {
  cookie: string;
  csrfToken: string;
  loginCookieBefore: string | undefined;
  loginCookieAfter: string | undefined;
}

/**
 * Drive the OIDC login flow (login → callback) and, unless `fetchCsrf` is false, fetch a
 * CSRF token. (Fetching CSRF hits an authenticated route, so it counts toward the per-user
 * rate limit — tests exercising that limit pass `fetchCsrf: false`.)
 */
export async function login(
  harness: InternalHarness,
  { code = 'good', fetchCsrf = true }: { code?: string; fetchCsrf?: boolean } = {},
): Promise<LoggedIn> {
  const r1 = await harness.app.inject({ method: 'GET', url: '/auth/login' });
  const beforeCookie = cookieHeader(r1);
  const loginCookieBefore = sessionCookieValue(r1);

  const r2 = await harness.app.inject({
    method: 'GET',
    url: `/auth/callback?code=${code}`,
    headers: { cookie: beforeCookie },
  });
  const loginCookieAfter = sessionCookieValue(r2);
  const cookie = cookieHeader(r2) || beforeCookie;

  let csrfToken = '';
  if (fetchCsrf) {
    const r3 = await harness.app.inject({ method: 'GET', url: '/auth/csrf', headers: { cookie } });
    const parsed: { csrfToken: string } = r3.json();
    csrfToken = parsed.csrfToken;
  }

  return { cookie, csrfToken, loginCookieBefore, loginCookieAfter };
}
