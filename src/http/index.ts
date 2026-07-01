/**
 * The shared HTTP hardening & auth middleware (Task 2.3). Every surface in the system builds
 * on the two app factories here rather than rolling its own protections. See
 * `docs/http-middleware.md` for what each consuming task still owns.
 */

// Type augmentation for `request.user`, `config.public`, and session fields.
import './types.js';

// App factories — the primary entry points.
export {
  createInternalApp,
  createWebhookApp,
  getCsrfToken,
  type InternalAppDeps,
  type WebhookApp,
  type WebhookAppDeps,
} from './app.js';

// Error-shaping (for surfaces that need the status map directly).
export { toHttpError, httpStatusFor, type HttpErrorResponse } from './errors.js';

// Auth port + the concrete OIDC adapter.
export type {
  AuthProvider,
  AuthenticatedUser,
  AuthorizationRequest,
  CallbackParams,
} from './auth/provider.js';
export {
  OidcAuthProvider,
  oidcProviderFromConfig,
  oidcSettingsFromConfig,
} from './auth/oidc-provider.js';

// Webhook building blocks (a consuming task supplies the provider specifics).
export { hmacSha256Hex, timingSafeEqualHex, type SignatureVerifier } from './webhook/signature.js';
export { isTimestampFresh } from './webhook/timestamp.js';
export type { WebhookRouteOptions } from './webhook/register.js';

// Stores: interfaces, Redis implementations, and in-memory fakes.
export {
  type Clock,
  type RateStore,
  type ReplayStore,
  type Reservation,
  systemClock,
} from './stores/types.js';
export {
  createRedisClient,
  RedisRateStore,
  RedisReplayStore,
  RedisSessionStore,
  type SessionStoreLike,
} from './stores/redis.js';
export { MemoryRateStore, MemoryReplayStore } from './stores/memory.js';

// Example routes — the reference for consuming tasks and the test suite.
export { registerInternalExampleRoutes, registerWebhookExampleRoute } from './example-routes.js';
