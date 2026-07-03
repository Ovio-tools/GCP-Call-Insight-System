import type { Redis } from 'ioredis';

/**
 * A rate limiter for OUTBOUND Dialpad calls. Every request calls `acquire()`, which resolves
 * only once BOTH limits — the transcript-endpoint per-minute cap and the company-wide
 * per-second cap — have capacity. The tighter of the two always governs.
 */
export interface Limiter {
  acquire(): Promise<void>;
}

export interface DualWindowLimits {
  /** Company-wide cap: requests per second. */
  perSecond: number;
  /** Transcript-endpoint cap: requests per minute. */
  perMinute: number;
}

/** Injectable time + delay so backoff/window tests run deterministically under fake timers. */
export interface LimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realLimiterClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

/**
 * Process-local fixed-window limiter. Correct for a SINGLE process only — it does not
 * coordinate across worker/cron instances. Used in unit tests (with an injected clock) and as
 * a fallback; production shares one {@link RedisDualWindowLimiter}.
 *
 * Both enforce the same caps but anchor their fixed windows differently: this one on
 * EPOCH-aligned buckets (`floor(now / windowMs)`), while the Redis limiter anchors each window
 * on its first admitted request (TTL-from-first-admit). Either respects the per-window cap;
 * they can differ only in window PHASE at a boundary, which does not affect the limit. So the
 * memory limiter is representative of the caps, not a byte-for-byte model of the Redis clock.
 */
export class MemoryLimiter implements Limiter {
  private secWindow = -1;
  private secCount = 0;
  private minWindow = -1;
  private minCount = 0;

  constructor(
    private readonly limits: DualWindowLimits,
    private readonly clock: LimiterClock = realLimiterClock,
  ) {}

  async acquire(): Promise<void> {
    // Loop: reserve as soon as both windows have room, otherwise sleep until the fuller
    // window rolls over. A `while (true)` (not one-shot) so a burst is paced, not dropped.
    for (;;) {
      const now = this.clock.now();
      const secWindow = Math.floor(now / SECOND_MS);
      const minWindow = Math.floor(now / MINUTE_MS);

      if (secWindow !== this.secWindow) {
        this.secWindow = secWindow;
        this.secCount = 0;
      }
      if (minWindow !== this.minWindow) {
        this.minWindow = minWindow;
        this.minCount = 0;
      }

      if (this.secCount < this.limits.perSecond && this.minCount < this.limits.perMinute) {
        this.secCount += 1;
        this.minCount += 1;
        return;
      }

      const waitSec =
        this.secCount >= this.limits.perSecond ? (secWindow + 1) * SECOND_MS - now : 0;
      const waitMin =
        this.minCount >= this.limits.perMinute ? (minWindow + 1) * MINUTE_MS - now : 0;
      // Wait until BOTH windows can admit: the later of the two blocking rollovers.
      await this.clock.sleep(Math.max(1, waitSec, waitMin));
    }
  }
}

/**
 * One atomic check-and-increment across both windows. Increments BOTH keys only if BOTH
 * have capacity; otherwise increments NEITHER and returns the ms to wait (the PTTL of the
 * full window). Two independent INCRs would race — one bucket could advance while the other
 * is full — so this MUST stay a single script.
 */
const DUAL_WINDOW_SCRIPT = `
local sec = tonumber(redis.call('GET', KEYS[1]) or '0')
local min = tonumber(redis.call('GET', KEYS[2]) or '0')
local perSec = tonumber(ARGV[1])
local perMin = tonumber(ARGV[2])
if sec < perSec and min < perMin then
  -- Set the TTL only when the counter is first created (INCR returns 1), so a later request
  -- in the same window can NEVER extend it: a true fixed window, not a sliding one.
  if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
  if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[4]) end
  return 0
end
local waitSec = 0
local waitMin = 0
if sec >= perSec then waitSec = redis.call('PTTL', KEYS[1]) end
if min >= perMin then waitMin = redis.call('PTTL', KEYS[2]) end
local w = math.max(waitSec, waitMin)
if w < 1 then w = 1 end
return w
`;

/**
 * Shared, distributed limiter. Every worker and the reconciliation cron point their clients
 * at the same Redis, so the company-wide 20/sec and 1200/min caps hold across horizontal
 * scaling, not just within one process. Fixed-window via INCR+PEXPIRE — the same primitive
 * the inbound HTTP rate limiter uses.
 */
export class RedisDualWindowLimiter implements Limiter {
  private readonly secKey: string;
  private readonly minKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly limits: DualWindowLimits,
    private readonly clock: LimiterClock = realLimiterClock,
    keyPrefix = 'dialpad:rl:',
  ) {
    this.secKey = `${keyPrefix}sec`;
    this.minKey = `${keyPrefix}min`;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const wait = Number(
        await this.redis.eval(
          DUAL_WINDOW_SCRIPT,
          2,
          this.secKey,
          this.minKey,
          String(this.limits.perSecond),
          String(this.limits.perMinute),
          String(SECOND_MS),
          String(MINUTE_MS),
        ),
      );
      if (wait === 0) return;
      await this.clock.sleep(wait);
    }
  }
}
