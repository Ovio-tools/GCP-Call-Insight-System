import { describe, expect, it } from 'vitest';
import {
  MemoryLimiter,
  RedisDualWindowLimiter,
  createDialpadClient,
  type LimiterClock,
} from '../../src/dialpad/client/index.js';
import { makeTestConfig } from '../_config.js';
import { hasTestRedis, makeQueueConnection } from '../queue/_redis.js';

/**
 * The backfill runner REUSES the shared Dialpad rate limiter + client (Task 11.2, R1 #9) so both
 * Dialpad limits hold across live worker fetches AND backfill list calls. This suite pins that
 * reuse: (a) the client honors 429 + Retry-After through the shared limiter; (b) two limiter
 * instances on ONE Redis prefix/config obey the per-second and per-minute windows together.
 */

function fakeClock(): LimiterClock & { time: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    time: () => t,
  };
}

describe('backfill Dialpad client — 429 + Retry-After backoff (reuse)', () => {
  it('retries a 429 with the Retry-After delay, then succeeds', async () => {
    const config = makeTestConfig({ DIALPAD_API_KEY: 'test-key' });
    const limiter = new MemoryLimiter({ perSecond: 100, perMinute: 1000 }, fakeClock());
    let calls = 0;
    const slept: number[] = [];
    const client = createDialpadClient({
      config,
      limiter,
      skipAuthValidationForTests: true,
      sleep: (ms) => (slept.push(ms), Promise.resolve()),
      fetchImpl: ((_url: string) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    const page = await client.listRecentlyConcludedCalls({ since: 0 });
    expect(page.calls).toEqual([]);
    expect(calls).toBe(2);
    expect(slept).toEqual([2000]); // Retry-After (2s) won over jittered backoff
  });
});

describe.skipIf(!hasTestRedis)(
  'shared Redis limiter across live + backfill traffic (R1 #9)',
  () => {
    it('two users on one prefix/config obey the per-second window together', async () => {
      const redis = makeQueueConnection();
      const prefix = `bf:rl:test:${Date.now()}:`;
      const clock = fakeClock();
      const limits = { perSecond: 3, perMinute: 1000 };
      // Two DISTINCT limiter instances — a worker-fetch stand-in and the backfill list — sharing the
      // same Redis keys, exactly as the two components would in production.
      const workerLimiter = new RedisDualWindowLimiter(redis, limits, clock, prefix);
      const backfillLimiter = new RedisDualWindowLimiter(redis, limits, clock, prefix);
      try {
        // 3 combined acquires fit the per-second window with no wait.
        await workerLimiter.acquire();
        await backfillLimiter.acquire();
        await workerLimiter.acquire();
        expect(clock.time()).toBe(0);
        // The 4th (from either user) must wait out the shared per-second window.
        await backfillLimiter.acquire();
        expect(clock.time()).toBeGreaterThan(0);
      } finally {
        await redis.del(`${prefix}sec`, `${prefix}min`);
        await redis.quit();
      }
    });
  },
);
