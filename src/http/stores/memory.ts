import {
  type Clock,
  type RateStore,
  type ReplayStore,
  type Reservation,
  NOT_ACQUIRED,
  systemClock,
} from './types.js';

/**
 * In-memory fakes for unit tests. Per-process only — never wire these across the separate
 * webhook/worker/surface services; use the Redis implementations for that. A shared {@link
 * Clock} lets a test advance time to exercise window/TTL expiry without real waiting.
 */

export class MemoryRateStore implements RateStore {
  private readonly hits = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly clock: Clock = systemClock) {}

  incr(key: string, windowMs: number): Promise<number> {
    const now = this.clock.now();
    const current = this.hits.get(key);
    if (!current || current.expiresAt <= now) {
      this.hits.set(key, { count: 1, expiresAt: now + windowMs });
      return Promise.resolve(1);
    }
    current.count += 1;
    return Promise.resolve(current.count);
  }
}

interface ReplayEntry {
  state: 'reserved' | 'committed';
  expiresAt: number;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();

  constructor(private readonly clock: Clock = systemClock) {}

  reserve(key: string, windowMs: number): Promise<Reservation> {
    const now = this.clock.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return Promise.resolve(NOT_ACQUIRED);
    }
    this.entries.set(key, { state: 'reserved', expiresAt: now + windowMs });

    const entries = this.entries;
    const clock = this.clock;
    return Promise.resolve({
      acquired: true,
      commit() {
        entries.set(key, { state: 'committed', expiresAt: clock.now() + windowMs });
        return Promise.resolve();
      },
      release() {
        const entry = entries.get(key);
        if (entry && entry.state === 'reserved') {
          entries.delete(key);
        }
        return Promise.resolve();
      },
    });
  }
}
