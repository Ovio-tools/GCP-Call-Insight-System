import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRootLogger } from '../../src/logging/logger.js';
import {
  pingSuccess,
  startLivenessHeartbeat,
  type IntervalScheduler,
} from '../../src/heartbeat/emit.js';

const WORKER_URL = 'https://checks.example.com/ping/worker-secret-id';
const RECON_URL = 'https://checks.example.com/ping/recon-secret-id';
const RETENTION_URL = 'https://checks.example.com/ping/retention-secret-id';

function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
}

/** A scheduler that captures the interval callback so tests drive beats deterministically. */
function manualScheduler(): {
  scheduler: IntervalScheduler;
  fire: () => void;
  intervalMs: number | undefined;
  cleared: boolean;
} {
  const state = {
    fire: (): void => {},
    intervalMs: undefined as number | undefined,
    cleared: false,
  };
  const scheduler: IntervalScheduler = {
    set(callback, ms) {
      state.fire = callback;
      state.intervalMs = ms;
      return Symbol('handle');
    },
    clear() {
      state.cleared = true;
    },
  };
  return {
    scheduler,
    get fire() {
      return state.fire;
    },
    get intervalMs() {
      return state.intervalMs;
    },
    get cleared() {
      return state.cleared;
    },
  };
}

describe('pingSuccess', () => {
  it('pings the given URL exactly once', async () => {
    const { logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());

    await pingSuccess({ component: 'retention-cron', url: RETENTION_URL, logger, ping });

    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith(RETENTION_URL);
  });

  it('does not ping when the component has no configured URL', async () => {
    const { logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());

    await pingSuccess({ component: 'retention-cron', url: undefined, logger, ping });

    expect(ping).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and never throws when the ping rejects', async () => {
    const { lines, logger } = collectingLogger();
    const ping = vi.fn(() => Promise.reject(new Error(`connect ECONNREFUSED ${RETENTION_URL}`)));

    await expect(
      pingSuccess({ component: 'retention-cron', url: RETENTION_URL, logger, ping }),
    ).resolves.toBeUndefined();

    const line = lines.find((l) => l.includes('external check ping failed'));
    expect(line).toBeDefined();
    expect(line).toContain('retention-cron');
    // No URL / secret / raw message leaks into the log.
    expect(line).not.toContain('retention-secret-id');
    expect(line).not.toContain('checks.example.com');
  });
});

describe('startLivenessHeartbeat', () => {
  it('schedules on the configured interval and pings the worker’s own URL each beat', async () => {
    const { logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 15_000,
      logger,
      ping,
      scheduler: m.scheduler,
    });

    expect(m.intervalMs).toBe(15_000);

    // Idle-queue analogue: nothing to process, yet each beat still pings — liveness, not
    // throughput. And it only ever pings WORKER_URL, never a cron URL.
    await hb.beat();
    await hb.beat();
    await hb.beat();

    expect(ping).toHaveBeenCalledTimes(3);
    for (const call of ping.mock.calls) expect(call[0]).toBe(WORKER_URL);
    // Never a cron URL — the worker heartbeat is bound to exactly one URL at construction.
    expect(ping.mock.calls.some((c) => c[0] === RECON_URL || c[0] === RETENTION_URL)).toBe(false);
  });

  it('skips the beat (no ping) when the health probe reports unhealthy', async () => {
    const { lines, logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping,
      isHealthy: () => false,
      scheduler: m.scheduler,
    });

    await hb.beat();

    expect(ping).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('heartbeat skipped: dependencies unhealthy'))).toBe(true);
  });

  it('treats a throwing health probe as unhealthy and does not ping', async () => {
    const { logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping,
      isHealthy: () => {
        throw new Error('redis down');
      },
      scheduler: m.scheduler,
    });

    await hb.beat();

    expect(ping).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure (no URL) when a beat’s ping rejects', async () => {
    const { lines, logger } = collectingLogger();
    const ping = vi.fn(() => Promise.reject(new Error(`request to ${WORKER_URL} failed`)));
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping,
      scheduler: m.scheduler,
    });

    await hb.beat();

    const line = lines.find((l) => l.includes('heartbeat ping failed'));
    expect(line).toBeDefined();
    expect(line).not.toContain('worker-secret-id');
    expect(line).not.toContain('checks.example.com');
  });

  it('runs the in-DB mirror after a healthy beat, and the ping is not gated on it', async () => {
    const { logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    const mirror = vi.fn(() => Promise.resolve());
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping,
      mirror,
      scheduler: m.scheduler,
    });

    await hb.beat();
    expect(ping).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  it('a failing mirror never blocks the ping and is sanitized-logged, not thrown', async () => {
    const { lines, logger } = collectingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    const mirror = vi.fn(() => Promise.reject(new Error('db write failed')));
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping,
      mirror,
      scheduler: m.scheduler,
    });

    await expect(hb.beat()).resolves.toBeUndefined();
    // The authoritative external ping still fired.
    expect(ping).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('heartbeat DB mirror failed'))).toBe(true);
  });

  it('does not run the mirror when the health probe reports unhealthy', async () => {
    const { logger } = collectingLogger();
    const mirror = vi.fn(() => Promise.resolve());
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping: () => Promise.resolve(),
      isHealthy: () => false,
      mirror,
      scheduler: m.scheduler,
    });

    await hb.beat();
    expect(mirror).not.toHaveBeenCalled();
  });

  it('stop() clears the scheduled interval', () => {
    const { logger } = collectingLogger();
    const m = manualScheduler();

    const hb = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 60_000,
      logger,
      ping: () => Promise.resolve(),
      scheduler: m.scheduler,
    });

    hb.stop();
    expect(m.cleared).toBe(true);
  });
});
