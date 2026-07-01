import { Redis, type RedisOptions } from 'ioredis';
import type { RateStore, ReplayStore, Reservation } from './types.js';
import { NOT_ACQUIRED } from './types.js';

/**
 * Structural shape of the `@fastify/session` store contract (its own `SessionStore` type is
 * awkward to import through the package's `export =` + namespace). This matches the plugin's
 * `store` option structurally, so `new RedisSessionStore(...)` can be passed directly.
 */
export interface SessionStoreLike {
  set(sessionId: string, session: unknown, callback: (err?: unknown) => void): void;
  get(sessionId: string, callback: (err: unknown, session?: unknown) => void): void;
  destroy(sessionId: string, callback: (err?: unknown) => void): void;
}

/**
 * The Redis implementations of the middleware stores, plus a general-purpose ioredis
 * factory. Unlike the BullMQ connection (`src/queue/connection.ts`), this deliberately does
 * NOT force `maxRetriesPerRequest: null` — that is a BullMQ blocking-command requirement,
 * wrong for ordinary GET/SET/EVAL traffic.
 */
export function createRedisClient(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, options);
}

/** Atomic increment + first-hit expiry, so the window can never leak without a TTL. */
const INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count`;

export class RedisRateStore implements RateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'rl:',
  ) {}

  async incr(key: string, windowMs: number): Promise<number> {
    const count = await this.redis.eval(INCR_WITH_TTL, 1, this.prefix + key, String(windowMs));
    return Number(count);
  }
}

/** Delete only if still in the `reserved` state, so release never drops a committed entry. */
const RELEASE_IF_RESERVED = `
if redis.call('GET', KEYS[1]) == 'reserved' then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class RedisReplayStore implements ReplayStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'replay:',
  ) {}

  async reserve(key: string, windowMs: number): Promise<Reservation> {
    const fullKey = this.prefix + key;
    // SET NX PX is the atomic reserve: only the first caller for this key acquires it.
    const acquired = await this.redis.set(fullKey, 'reserved', 'PX', windowMs, 'NX');
    if (acquired !== 'OK') {
      return NOT_ACQUIRED;
    }
    const redis = this.redis;
    return {
      acquired: true,
      async commit() {
        await redis.set(fullKey, 'committed', 'PX', windowMs);
      },
      async release() {
        await redis.eval(RELEASE_IF_RESERVED, 1, fullKey);
      },
    };
  }
}

/**
 * A Redis-backed `@fastify/session` store: revocable, shared across instances, TTL-expired.
 * Sessions are JSON with a bounded lifetime; nothing sensitive beyond the opaque session id
 * lives in the cookie itself.
 */
export class RedisSessionStore implements SessionStoreLike {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number,
    private readonly prefix = 'sess:',
  ) {}

  set(sessionId: string, session: unknown, callback: (err?: unknown) => void): void {
    this.redis
      .set(this.prefix + sessionId, JSON.stringify(session), 'PX', this.ttlMs)
      .then(() => callback())
      .catch(callback);
  }

  get(sessionId: string, callback: (err: unknown, session?: unknown) => void): void {
    this.redis
      .get(this.prefix + sessionId)
      .then((raw) => callback(null, raw ? (JSON.parse(raw) as unknown) : null))
      .catch((err: unknown) => callback(err));
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    this.redis
      .del(this.prefix + sessionId)
      .then(() => callback())
      .catch(callback);
  }
}
