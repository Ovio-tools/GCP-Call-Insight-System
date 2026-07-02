import { describe, expect, it } from 'vitest';
import {
  MemoryLimiter,
  RedisDualWindowLimiter,
  type LimiterClock,
} from '../../../src/dialpad/client/limiter.js';

/** A controllable clock: `sleep` advances virtual time and records how long it waited. */
function fakeClock(): LimiterClock & { sleeps: number[]; time: () => number } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
    time: () => t,
  };
}

describe('MemoryLimiter (enforces the tighter of the two windows)', () => {
  it('paces a burst at the per-second cap', async () => {
    const clock = fakeClock();
    const limiter = new MemoryLimiter({ perSecond: 2, perMinute: 1000 }, clock);

    for (let i = 0; i < 5; i += 1) await limiter.acquire();

    // 5 requests at 2/sec → the 3rd and 5th each wait a full second window.
    expect(clock.sleeps).toEqual([1000, 1000]);
    expect(clock.time()).toBe(2000);
  });

  it('lets the per-minute cap govern when it is the tighter limit', async () => {
    const clock = fakeClock();
    const limiter = new MemoryLimiter({ perSecond: 100, perMinute: 2 }, clock);

    for (let i = 0; i < 3; i += 1) await limiter.acquire();

    // The 3rd request must wait out the whole minute, not just a second.
    expect(clock.sleeps).toEqual([60_000]);
  });

  it('requires BOTH windows to have capacity (tighter second limit blocks despite minute room)', async () => {
    const clock = fakeClock();
    const limiter = new MemoryLimiter({ perSecond: 1, perMinute: 5 }, clock);

    await limiter.acquire();
    await limiter.acquire();

    // Minute had room (5), but the per-second cap of 1 forced a one-second wait.
    expect(clock.sleeps).toEqual([1000]);
  });

  it('never admits more than perSecond within any one-second window', async () => {
    const clock = fakeClock();
    const perSecond = 3;
    const limiter = new MemoryLimiter({ perSecond, perMinute: 10_000 }, clock);

    const admitTimes: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await limiter.acquire();
      admitTimes.push(clock.time());
    }

    // Bucket admissions by their second and assert no bucket exceeds the cap.
    const perBucket = new Map<number, number>();
    for (const t of admitTimes) {
      const bucket = Math.floor(t / 1000);
      perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
    }
    for (const count of perBucket.values()) expect(count).toBeLessThanOrEqual(perSecond);
  });
});

/**
 * The distributed limiter's correctness only shows up with a real Redis shared by multiple
 * instances. Gated on TEST_REDIS_URL so it runs in CI and skips locally without Redis.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!TEST_REDIS_URL)('RedisDualWindowLimiter (shared across instances)', () => {
  it('two instances sharing Redis never exceed either cap under concurrency', async () => {
    const { Redis } = await import('ioredis');
    const prefix = `test:dialpad:rl:${Date.now()}:`;
    const redisA = new Redis(TEST_REDIS_URL as string);
    const redisB = new Redis(TEST_REDIS_URL as string);
    try {
      const limits = { perSecond: 5, perMinute: 1000 };
      // Real clock, but every acquire happens within one second window here.
      const a = new RedisDualWindowLimiter(redisA, limits, undefined, prefix);
      const b = new RedisDualWindowLimiter(redisB, limits, undefined, prefix);

      // Fire 5 concurrent acquires across both instances; all should be admitted (cap 5),
      // and none should have had to sleep.
      const start = Date.now();
      await Promise.all([a.acquire(), a.acquire(), b.acquire(), b.acquire(), a.acquire()]);
      expect(Date.now() - start).toBeLessThan(500);

      // The shared per-second counter is now at the cap.
      const secCount = Number(await redisA.get(`${prefix}sec`));
      expect(secCount).toBeLessThanOrEqual(limits.perSecond);
      expect(secCount).toBe(5);
    } finally {
      await redisA.quit();
      await redisB.quit();
    }
  });

  it('uses a fixed window: a later admitted request does not extend the first window TTL', async () => {
    const { Redis } = await import('ioredis');
    const prefix = `test:dialpad:rl:ttl:${Date.now()}:`;
    const redis = new Redis(TEST_REDIS_URL as string);
    try {
      const limiter = new RedisDualWindowLimiter(
        redis,
        { perSecond: 100, perMinute: 100 },
        undefined,
        prefix,
      );
      await limiter.acquire();
      const ttl1 = await redis.pttl(`${prefix}min`);
      await limiter.acquire();
      const ttl2 = await redis.pttl(`${prefix}min`);
      // PEXPIRE only fires on the first INCR, so the window's deadline never moves forward.
      expect(ttl2).toBeLessThanOrEqual(ttl1);
    } finally {
      await redis.quit();
    }
  });
});
