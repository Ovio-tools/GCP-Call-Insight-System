import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRootLogger } from '../../src/logging/logger.js';
import { startLivenessHeartbeat, type IntervalScheduler } from '../../src/heartbeat/emit.js';
import { runReconciliation } from '../../src/reconciliation/run.js';
import { runRetention } from '../../src/retention/run.js';
import { DialpadError, type DialpadClient } from '../../src/dialpad/client/index.js';
import { makeTestConfig } from '../_config.js';

const WORKER_URL = 'https://checks.example.com/ping/worker';
const RECON_URL = 'https://checks.example.com/ping/recon';
const RETENTION_URL = 'https://checks.example.com/ping/retention';

function silentLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'silent', destination: sink });
}

function noopScheduler(): IntervalScheduler {
  return { set: () => Symbol('handle'), clear: () => {} };
}

/**
 * The three components share NO ping client — each is handed its own pinger bound to its own
 * URL. These scenarios prove a stalled cron goes quiet on ITS OWN check while the worker keeps
 * beating on ITS check: exactly what the per-component dead-man's switches must guarantee.
 */
describe('per-component heartbeat independence', () => {
  it('worker keeps beating while a stalled reconciliation cron never pings its own check', async () => {
    const logger = silentLogger();
    const workerPing = vi.fn((_url: string) => Promise.resolve());
    const reconPing = vi.fn((_url: string) => Promise.resolve());

    const heartbeat = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 1_000,
      logger,
      ping: workerPing,
      scheduler: noopScheduler(),
    });

    // Reconciliation stalls: the Dialpad listing errors out mid-run.
    const failing: Pick<DialpadClient, 'listRecentlyConcludedCalls'> = {
      listRecentlyConcludedCalls: () =>
        Promise.reject(new DialpadError('rate_limited', { endpoint: 'calls', status: 429, attempts: 5 })),
    };
    const reconConfig = makeTestConfig({ RECONCILIATION_CHECK_URL: RECON_URL });

    // Worker beats several times across the window in which reconciliation is failing.
    await heartbeat.beat();
    await expect(
      runReconciliation({
        config: reconConfig,
        logger,
        client: failing,
        alreadyInPipeline: () => Promise.resolve(false),
        ingestGap: () => Promise.resolve(),
        pingCheck: reconPing,
        clock: { now: () => 1_750_000_000_000 },
      }),
    ).rejects.toBeInstanceOf(DialpadError);
    await heartbeat.beat();

    // Worker check: alive and green. Reconciliation check: silent → the monitor alerts and
    // names reconciliation-cron.
    expect(workerPing.mock.calls.every((c) => c[0] === WORKER_URL)).toBe(true);
    expect(workerPing.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reconPing).not.toHaveBeenCalled();
  });

  it('a stalled retention cron never pings its own check while the worker stays green', async () => {
    const logger = silentLogger();
    const workerPing = vi.fn((_url: string) => Promise.resolve());
    const retentionPing = vi.fn((_url: string) => Promise.resolve());

    const heartbeat = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 1_000,
      logger,
      ping: workerPing,
      scheduler: noopScheduler(),
    });

    const retentionConfig = makeTestConfig({ RETENTION_CHECK_URL: RETENTION_URL });

    await heartbeat.beat();
    await expect(
      runRetention({
        config: retentionConfig,
        logger,
        purge: () => Promise.reject(new Error('purge stalled')),
        pingCheck: retentionPing,
      }),
    ).rejects.toThrow('purge stalled');
    await heartbeat.beat();

    expect(workerPing.mock.calls.every((c) => c[0] === WORKER_URL)).toBe(true);
    expect(retentionPing).not.toHaveBeenCalled();
  });
});
