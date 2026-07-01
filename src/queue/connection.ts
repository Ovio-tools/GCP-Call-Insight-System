import { Redis, type RedisOptions } from 'ioredis';
import type { Config } from '../config/schema.js';

/**
 * Build the ioredis connection BullMQ uses for the pipeline queue and worker.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ: its blocking commands (BRPOPLPUSH
 * etc.) must not be capped or ioredis would abort them mid-wait. This is the opposite of
 * the readiness probe, which caps retries so a boot check fails fast instead of hanging.
 */
export function createQueueConnection(url: string, options: RedisOptions = {}): Redis {
  // Force maxRetriesPerRequest LAST: BullMQ requires null, so a caller's override can't break it.
  return new Redis(url, { ...options, maxRetriesPerRequest: null });
}

/**
 * Convenience wrapper that reads `REDIS_URL` from validated config. The URL's presence and
 * reachability are owned by the boot readiness check (REDIS_UNAVAILABLE), so by the time
 * the worker builds its connection the value is known-good; this throws only as a
 * defensive guard for callers that skip readiness (e.g. focused tests).
 */
export function createQueueConnectionFromConfig(config: Config, options: RedisOptions = {}): Redis {
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is not set; cannot create the BullMQ connection');
  }
  return createQueueConnection(config.REDIS_URL, options);
}
