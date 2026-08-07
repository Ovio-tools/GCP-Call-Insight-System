import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { IntervalScheduler } from '../../src/heartbeat/index.js';
import {
  createBackfillMonitor,
  type BackfillSignalUrls,
} from '../../src/heartbeat/backfill-monitor.js';

const SIGNALS: BackfillSignalUrls = {
  start: 'https://mon/start',
  progress: 'https://mon/progress',
  success: 'https://mon',
  fail: 'https://mon/fail',
};

const noopLogger = { warn: () => undefined, info: () => undefined } as unknown as Logger;

/** A scheduler whose single registered callback the test invokes manually via `tick()`. */
function fakeScheduler(): { scheduler: IntervalScheduler; tick(): void; cleared: () => boolean } {
  let cb: (() => void) | undefined;
  let handle: object | undefined;
  let clearedHandle: object | undefined;
  return {
    scheduler: {
      set(callback) {
        cb = callback;
        handle = {};
        return handle;
      },
      clear(h) {
        clearedHandle = h as object;
      },
    },
    tick: () => cb?.(),
    cleared: () => clearedHandle !== undefined && clearedHandle === handle,
  };
}

function pings(): { ping: (url: string) => Promise<void>; urls: string[] } {
  const urls: string[] = [];
  return { ping: (url) => (urls.push(url), Promise.resolve()), urls };
}

describe('createBackfillMonitor (four-signal job monitor)', () => {
  it('rejects a pairwise URL collision at construction, before any ping', () => {
    const { ping } = pings();
    expect(() =>
      createBackfillMonitor({
        signals: { ...SIGNALS, progress: SIGNALS.success },
        component: 'backfill',
        ping,
        scheduler: fakeScheduler().scheduler,
        now: () => 0,
        logger: noopLogger,
        progressIntervalMs: 1000,
        stallThresholdMs: 10_000,
      }),
    ).toThrow(/distinct|collision/i);
  });

  it('sends exactly one start ping to the start URL', async () => {
    const { ping, urls } = pings();
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    expect(urls).toEqual([SIGNALS.start]);
  });

  it('sends periodic progress pings while active and below the stall threshold (R2 #7)', async () => {
    const { ping, urls } = pings();
    const fake = fakeScheduler();
    let clock = 0;
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fake.scheduler,
      now: () => clock,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start(); // start ping; lastProgressAt = 0
    clock = 1000;
    fake.tick(); // within threshold → progress ping
    clock = 2000;
    fake.tick(); // still within threshold, count static → still pings
    expect(urls).toEqual([SIGNALS.start, SIGNALS.progress, SIGNALS.progress]);
  });

  it('WITHHOLDS progress pings past the stall threshold (R1 #11)', async () => {
    const { ping, urls } = pings();
    const fake = fakeScheduler();
    const warn = vi.fn();
    let clock = 0;
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fake.scheduler,
      now: () => clock,
      logger: { warn, info: () => undefined } as unknown as Logger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    clock = 20_000; // past stall threshold since lastProgressAt=0
    fake.tick();
    expect(urls).toEqual([SIGNALS.start]); // no progress ping
    expect(warn).toHaveBeenCalled();
  });

  it('recordProgress refreshes the stall clock so pings resume', async () => {
    const { ping, urls } = pings();
    const fake = fakeScheduler();
    let clock = 0;
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fake.scheduler,
      now: () => clock,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    clock = 20_000;
    m.recordProgress({ terminalCount: 5 }); // lastProgressAt = 20000
    clock = 20_500;
    fake.tick(); // within threshold again
    expect(urls).toEqual([SIGNALS.start, SIGNALS.progress]);
  });

  it('success() pings the DISTINCT success URL exactly once and stops the interval (R1 #2)', async () => {
    const { ping, urls } = pings();
    const fake = fakeScheduler();
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fake.scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    await m.success();
    await m.success(); // terminated-guarded → no second ping
    expect(urls).toEqual([SIGNALS.start, SIGNALS.success]);
    expect(fake.cleared()).toBe(true);
    // A tick after terminal does nothing.
    fake.tick();
    expect(urls).toEqual([SIGNALS.start, SIGNALS.success]);
  });

  it('fail() pings the fail URL exactly once', async () => {
    const { ping, urls } = pings();
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    await m.fail();
    await m.fail();
    expect(urls).toEqual([SIGNALS.start, SIGNALS.fail]);
  });

  it('idle (never started) emits nothing', () => {
    const { ping, urls } = pings();
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping,
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    m.stop();
    expect(urls).toEqual([]);
  });

  it('start()/success() do NOT resolve until the ping settles (no lost terminal signal on exit)', async () => {
    // A deferred ping: resolves only when we call `release()`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pinged: string[] = [];
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping: (url: string) => {
        pinged.push(url);
        return gate;
      },
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });

    // start() awaits its ping — pending until the deferred ping settles.
    let startResolved = false;
    const startP = m.start().then(() => {
      startResolved = true;
    });
    await Promise.resolve();
    expect(startResolved).toBe(false);
    release();
    await startP;
    expect(startResolved).toBe(true);

    // success() likewise does not resolve until its terminal ping settles.
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const m2 = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping: (url: string) => (url === SIGNALS.success ? gate2 : Promise.resolve()),
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m2.start();
    let successResolved = false;
    const successP = m2.success().then(() => {
      successResolved = true;
    });
    await Promise.resolve();
    expect(successResolved).toBe(false); // still awaiting the deferred success ping
    release2();
    await successP;
    expect(successResolved).toBe(true);
  });

  it('fail() does NOT resolve until the deferred terminal ping settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const m = createBackfillMonitor({
      signals: SIGNALS,
      component: 'backfill',
      ping: (url: string) => (url === SIGNALS.fail ? gate : Promise.resolve()),
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
      logger: noopLogger,
      progressIntervalMs: 1000,
      stallThresholdMs: 10_000,
    });
    await m.start();
    let failResolved = false;
    const failP = m.fail().then(() => {
      failResolved = true;
    });
    await Promise.resolve();
    expect(failResolved).toBe(false); // still awaiting the deferred fail ping
    release();
    await failP;
    expect(failResolved).toBe(true);
  });
});
