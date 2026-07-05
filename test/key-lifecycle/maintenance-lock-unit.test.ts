import { describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import { waitForDrain } from '../../src/key-lifecycle/maintenance-lock.js';

/** Pure logic for the drain poll — no Redis, injected clock/sleep. */
describe('waitForDrain', () => {
  it('returns true once the active count reaches zero', async () => {
    let calls = 0;
    const queue = {
      getActiveCount: () => Promise.resolve(calls++ < 2 ? 1 : 0),
    } as unknown as Queue;
    const drained = await waitForDrain(queue, {
      timeoutMs: 10_000,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(drained).toBe(true);
  });

  it('returns false on timeout when jobs never drain', async () => {
    let t = 0;
    const queue = { getActiveCount: () => Promise.resolve(1) } as unknown as Queue;
    const drained = await waitForDrain(queue, {
      timeoutMs: 100,
      pollMs: 10,
      now: () => (t += 30),
      sleep: async () => {},
    });
    expect(drained).toBe(false);
  });
});
