import type { onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import type { RateStore } from '../stores/types.js';
import { httpFailure } from '../failures.js';

/**
 * Two-tier per-source rate limiting over a shared {@link RateStore}. `user.id` is unknown at
 * `onRequest`, so a single key generator cannot cover both anonymous and authenticated
 * traffic — hence two explicit tiers.
 */

export interface RateLimitTier {
  max: number;
  windowMs: number;
}

export interface RateLimitDeps {
  rateStore: RateStore;
  environment: string;
}

/** Reject with the rate-limit failure via `done` when the count exceeds the tier max. */
function checkLimit(
  deps: RateLimitDeps,
  tier: RateLimitTier,
  key: string,
  done: (err?: Error) => void,
): void {
  deps.rateStore
    .incr(key, tier.windowMs)
    .then((count) =>
      done(count > tier.max ? httpFailure('RATE_LIMIT_EXCEEDED', deps.environment) : undefined),
    )
    .catch((err: unknown) => done(err as Error));
}

/** Tier 1: per-IP, runs `onRequest` for ALL traffic (protects login and anonymous hits). */
export function registerIpRateLimit(
  deps: RateLimitDeps,
  tier: RateLimitTier,
): onRequestHookHandler {
  return (request, _reply, done) => checkLimit(deps, tier, `ip:${request.ip}`, done);
}

/**
 * Tier 2: per-user, runs as a `preHandler` AFTER auth attaches `request.user`. Two users
 * behind the same IP get independent buckets. Skips when there is no user (the IP tier has
 * already covered anonymous traffic).
 */
export function registerUserRateLimit(
  deps: RateLimitDeps,
  tier: RateLimitTier,
): preHandlerHookHandler {
  return (request, _reply, done) => {
    const user = request.user;
    if (!user) {
      done();
      return;
    }
    checkLimit(deps, tier, `user:${user.id}`, done);
  };
}
