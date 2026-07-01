import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import type { AuthProvider, AuthenticatedUser } from '../auth/provider.js';
import type { SessionStoreLike } from '../stores/redis.js';
import { httpFailure } from '../failures.js';

/**
 * The internal-surface auth layer: server-side sessions (Redis in prod, in-memory in tests),
 * an OIDC authorization-code login with state/nonce/PKCE, session-id rotation on login,
 * and double-submit CSRF for unsafe methods. No anonymous access to non-public routes.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SessionConfig {
  secret: string;
  cookieName: string;
  ttlMs: number;
  cookieSecure: boolean;
  /** Undefined uses @fastify/session's in-memory store (tests); Redis store in prod. */
  store?: SessionStoreLike;
}

export interface AuthRoutesDeps {
  provider: AuthProvider;
  environment: string;
  /** Where to send the browser after a successful login/logout. */
  loginSuccessRedirect: string;
}

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** A safe local redirect target (same-origin path), or the default. Blocks open redirects. */
function safeReturnTo(candidate: unknown, fallback: string): string {
  if (typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//')) {
    return candidate;
  }
  return fallback;
}

/** preHandler: refuse anonymous access to non-public routes; expose `request.user`. */
export function requireAuth(environment: string): preHandlerHookHandler {
  return (request, _reply, done) => {
    if (request.routeOptions.config.public) {
      done();
      return;
    }
    const user = request.session.user;
    if (!user) {
      done(httpFailure('AUTH_REQUIRED', environment));
      return;
    }
    request.user = user;
    done();
  };
}

/** preHandler: require a valid CSRF token on unsafe methods for non-public routes. */
export function requireCsrf(environment: string): preHandlerHookHandler {
  return (request, _reply, done) => {
    if (SAFE_METHODS.has(request.method) || request.routeOptions.config.public) {
      done();
      return;
    }
    const expected = request.session.csrfToken;
    const provided = request.headers['x-csrf-token'];
    if (!expected || typeof provided !== 'string' || !constantTimeEqual(provided, expected)) {
      done(httpFailure('CSRF_TOKEN_INVALID', environment));
      return;
    }
    done();
  };
}

/** The CSRF token for the current session, for server-rendered handlers. */
export function getCsrfToken(request: FastifyRequest): string | undefined {
  return request.session.csrfToken;
}

/** Register the cookie + session plugins. Call BEFORE the global auth hooks. */
export async function registerSession(app: FastifyInstance, config: SessionConfig): Promise<void> {
  await app.register(cookie);
  await app.register(session, {
    secret: config.secret,
    cookieName: config.cookieName,
    // Structurally compatible with the plugin's SessionStore; omit entirely (not set to
    // undefined) so @fastify/session falls back to its in-memory store in tests.
    ...(config.store ? { store: config.store as never } : {}),
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.ttlMs,
    },
  });
}

/** Register the /auth/* routes. Call AFTER the global auth hooks so they are protected. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  // Begin login: stash state/nonce/PKCE in the session, redirect to the IdP.
  app.get('/auth/login', { config: { public: true } }, async (request, reply) => {
    const authReq = await deps.provider.createAuthorizationRequest();
    const returnTo = (request.query as { returnTo?: unknown }).returnTo;
    request.session.oidc = {
      state: authReq.state,
      nonce: authReq.nonce,
      codeVerifier: authReq.codeVerifier,
      ...(typeof returnTo === 'string' ? { returnTo } : {}),
    };
    return reply.redirect(authReq.url);
  });

  // Complete login: validate state/nonce/PKCE, rotate the session id, issue a CSRF token.
  app.get('/auth/callback', { config: { public: true } }, async (request, reply) => {
    const oidc = request.session.oidc;
    if (!oidc) {
      throw httpFailure('AUTH_REQUIRED', deps.environment);
    }
    let user: AuthenticatedUser;
    try {
      user = await deps.provider.exchangeCallback({
        callbackUrl: `${request.protocol}://${request.hostname}${request.url}`,
        state: oidc.state,
        nonce: oidc.nonce,
        codeVerifier: oidc.codeVerifier,
      });
    } catch {
      throw httpFailure('AUTH_REQUIRED', deps.environment);
    }
    const returnTo = oidc.returnTo;
    await request.session.regenerate(); // rotate session id — session-fixation defense
    request.session.user = user;
    request.session.csrfToken = randomToken();
    return reply.redirect(safeReturnTo(returnTo, deps.loginSuccessRedirect));
  });

  // Fetch the CSRF token for API-style clients (authenticated, safe method).
  app.get('/auth/csrf', (request) => ({ csrfToken: request.session.csrfToken ?? null }));

  // Logout: destroy the session, then optionally bounce through the IdP end-session URL.
  app.post('/auth/logout', async (request, reply) => {
    const endSession = deps.provider.endSessionUrl?.();
    await request.session.destroy();
    return reply.redirect(endSession ?? deps.loginSuccessRedirect);
  });
}
