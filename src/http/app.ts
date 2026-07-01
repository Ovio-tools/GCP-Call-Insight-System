import fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { logger as defaultLogger } from '../logging/logger.js';
import { createFailure } from '../failure-model/index.js';
import type { AuthProvider } from './auth/provider.js';
import type { Clock, RateStore, ReplayStore } from './stores/types.js';
import { systemClock } from './stores/types.js';
import type { SessionStoreLike } from './stores/redis.js';
import { parseCorsOrigins, registerSecurity } from './plugins/security.js';
import { installErrorHandler } from './plugins/error-handler.js';
import {
  getCsrfToken,
  registerAuthRoutes,
  registerSession,
  requireAuth,
  requireCsrf,
} from './plugins/auth.js';
import { registerIpRateLimit, registerUserRateLimit } from './plugins/rate-limit.js';
import { registerWebhook, type WebhookDeps, type WebhookRouteOptions } from './webhook/register.js';

/**
 * The two app factories every surface builds on. They pre-wire the full hardening stack in
 * the correct order so no consuming task re-implements — or accidentally skips — a protection.
 * Both accept injected stores/clock/provider so unit tests run with in-memory fakes.
 */

/** Trust exactly the configured number of proxy hops; 0 disables proxy trust entirely. */
function trustProxy(config: Config): boolean | number {
  return config.TRUSTED_PROXY_HOPS === 0 ? false : config.TRUSTED_PROXY_HOPS;
}

function failConfig(config: Config): never {
  throw createFailure('CONFIG_MISSING_OR_INVALID', {
    processingState: 'paused',
    context: { environment: config.NODE_ENV },
  });
}

export interface InternalAppDeps {
  config: Config;
  authProvider: AuthProvider;
  /** Shared rate-limit counters (Redis in prod; MemoryRateStore in tests). */
  rateStore: RateStore;
  /** Server-side session store (Redis in prod). Undefined → @fastify/session in-memory. */
  sessionStore?: SessionStoreLike;
  logger?: Logger;
  loginSuccessRedirect?: string;
}

/**
 * An internal surface (status, review, knowledge-base). Auth is enforced by default: any
 * route added later is protected unless it sets `config.public`. Lifecycle:
 * helmet/CORS → Tier-1 IP rate limit → session → requireAuth → Tier-2 user rate limit →
 * requireCsrf → handler → sanitized error handler.
 */
export async function createInternalApp(deps: InternalAppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const logger = deps.logger ?? defaultLogger;

  const secret = config.SESSION_SECRET;
  if (!secret) {
    failConfig(config);
  }
  // A non-secure session cookie must never ship in staging/production.
  if (
    !config.SESSION_COOKIE_SECURE &&
    (config.NODE_ENV === 'staging' || config.NODE_ENV === 'production')
  ) {
    failConfig(config);
  }

  const app = fastify({
    bodyLimit: config.HTTP_MAX_BODY_BYTES,
    trustProxy: trustProxy(config),
    logger: false,
  });

  await registerSecurity(app, parseCorsOrigins(config.CORS_ALLOWED_ORIGINS));

  const rlDeps = { rateStore: deps.rateStore, environment: config.NODE_ENV };
  const ipTier = { max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS };
  const userTier = { max: config.USER_RATE_LIMIT_MAX, windowMs: config.USER_RATE_LIMIT_WINDOW_MS };

  // Tier-1 IP limiter runs first, before any expensive work.
  app.addHook('onRequest', registerIpRateLimit(rlDeps, ipTier));

  const sessionConfig = {
    secret,
    cookieName: config.SESSION_COOKIE_NAME,
    ttlMs: config.SESSION_TTL_MS,
    cookieSecure: config.SESSION_COOKIE_SECURE,
    ...(deps.sessionStore ? { store: deps.sessionStore } : {}),
  };
  await registerSession(app, sessionConfig);

  // Global auth hooks, in order: authenticate → per-user rate limit → CSRF. Added BEFORE any
  // route is registered, so every route (auth routes, example routes, and the consuming
  // task's routes) is covered.
  app.addHook('preHandler', requireAuth(config.NODE_ENV));
  app.addHook('preHandler', registerUserRateLimit(rlDeps, userTier));
  app.addHook('preHandler', requireCsrf(config.NODE_ENV));

  registerAuthRoutes(app, {
    provider: deps.authProvider,
    environment: config.NODE_ENV,
    loginSuccessRedirect: deps.loginSuccessRedirect ?? '/',
  });

  installErrorHandler(app, { logger, environment: config.NODE_ENV });

  return app;
}

export interface WebhookApp {
  app: FastifyInstance;
  /** Register a signed webhook with the full verify chain. The only way to add one. */
  registerWebhook(opts: WebhookRouteOptions): void;
}

export interface WebhookAppDeps {
  config: Config;
  replayStore: ReplayStore;
  rateStore: RateStore;
  clock?: Clock;
  logger?: Logger;
}

/**
 * A webhook receiver. Raw body is preserved for signature verification; every route added
 * via `registerWebhook` is signature/timestamp/replay protected and rate-limited by
 * provider. Lifecycle: helmet/CORS → per-provider rate limit → raw-body parse →
 * signature → timestamp → replay reserve → handler → commit/release → sanitized errors.
 */
export async function createWebhookApp(deps: WebhookAppDeps): Promise<WebhookApp> {
  const { config } = deps;
  const logger = deps.logger ?? defaultLogger;

  const app = fastify({
    bodyLimit: config.HTTP_MAX_BODY_BYTES,
    trustProxy: trustProxy(config),
    logger: false,
  });

  // Preserve exact bytes for signature verification while still parsing JSON.
  await app.register(rawBody, { global: true, runFirst: true, encoding: false });
  await registerSecurity(app, parseCorsOrigins(config.CORS_ALLOWED_ORIGINS));

  const webhookDeps: WebhookDeps = {
    replayStore: deps.replayStore,
    rateStore: deps.rateStore,
    clock: deps.clock ?? systemClock,
    environment: config.NODE_ENV,
    replayWindowMs: config.WEBHOOK_REPLAY_WINDOW_MS,
    timestampSkewMs: config.WEBHOOK_TIMESTAMP_SKEW_MS,
    rateLimit: {
      max: config.WEBHOOK_RATE_LIMIT_MAX,
      windowMs: config.WEBHOOK_RATE_LIMIT_WINDOW_MS,
    },
  };

  installErrorHandler(app, { logger, environment: config.NODE_ENV });

  return {
    app,
    registerWebhook(opts: WebhookRouteOptions): void {
      registerWebhook(app, webhookDeps, opts);
    },
  };
}

export { getCsrfToken };
