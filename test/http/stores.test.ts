import { describe, expect, it } from 'vitest';
import { MemoryRateStore, MemoryReplayStore } from '../../src/http/index.js';
import { FakeClock } from './_helpers.js';

describe('MemoryRateStore', () => {
  it('counts within a window and resets after it expires', async () => {
    const clock = new FakeClock();
    const store = new MemoryRateStore(clock);
    expect(await store.incr('k', 1000)).toBe(1);
    expect(await store.incr('k', 1000)).toBe(2);
    clock.advance(1001);
    expect(await store.incr('k', 1000)).toBe(1);
  });

  it('keeps distinct keys independent', async () => {
    const store = new MemoryRateStore(new FakeClock());
    expect(await store.incr('a', 1000)).toBe(1);
    expect(await store.incr('b', 1000)).toBe(1);
  });
});

describe('MemoryReplayStore reserve/commit/release', () => {
  it('rejects a concurrent duplicate while reserved', async () => {
    const store = new MemoryReplayStore(new FakeClock());
    const first = await store.reserve('e', 1000);
    const second = await store.reserve('e', 1000);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
  });

  it('keeps a committed entry blocking within the window', async () => {
    const store = new MemoryReplayStore(new FakeClock());
    const r = await store.reserve('e', 1000);
    await r.commit();
    expect((await store.reserve('e', 1000)).acquired).toBe(false);
  });

  it('accepts again after release', async () => {
    const store = new MemoryReplayStore(new FakeClock());
    const r = await store.reserve('e', 1000);
    await r.release();
    expect((await store.reserve('e', 1000)).acquired).toBe(true);
  });

  it('accepts again after the window expires', async () => {
    const clock = new FakeClock();
    const store = new MemoryReplayStore(clock);
    const r = await store.reserve('e', 1000);
    await r.commit();
    clock.advance(1001);
    expect((await store.reserve('e', 1000)).acquired).toBe(true);
  });
});
