import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createRootLogger } from '../../src/logging/logger.js';
import { startLivenessHeartbeat, type IntervalScheduler } from '../../src/heartbeat/emit.js';
import { createWorkerLivenessProbe } from '../../src/heartbeat/worker-liveness.js';

const WORKER_URL = 'https://checks.example.com/ping/worker-secret-id';

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
 * The worker liveness probe is what makes the worker's dead-man's switch honest: it must go
 * unhealthy the instant the consumer stops consuming. Two ways a consumer dies: the BullMQ run
 * loop rejects/closes (isRunning() flips false), or the worker's OWN Redis link drops. A healthy
 * side/producer connection must NEVER keep the probe green — that is the exact hole the switch
 * exists to catch.
 */
describe('createWorkerLivenessProbe', () => {
  it('is healthy when the run loop is running and the consuming connection answers', async () => {
    const connection = { ping: vi.fn(() => Promise.resolve('PONG')) };
    const probe = createWorkerLivenessProbe({
      worker: { isRunning: () => true },
      connection,
      shouldConsume: true,
    });

    await expect(probe()).resolves.toBe(true);
    expect(connection.ping).toHaveBeenCalledTimes(1);
  });

  it('is unhealthy (and does not even ping) when the run loop has died', async () => {
    const connection = { ping: vi.fn(() => Promise.resolve('PONG')) };
    const probe = createWorkerLivenessProbe({
      worker: { isRunning: () => false },
      connection,
      shouldConsume: true,
    });

    await expect(probe()).resolves.toBe(false);
    // A dead run loop short-circuits: no point confirming Redis for a consumer that is gone.
    expect(connection.ping).not.toHaveBeenCalled();
  });

  it('rejects when the consuming connection is unreachable', async () => {
    const connection = { ping: vi.fn(() => Promise.reject(new Error('redis gone'))) };
    const probe = createWorkerLivenessProbe({
      worker: { isRunning: () => true },
      connection,
      shouldConsume: true,
    });

    await expect(probe()).rejects.toThrow('redis gone');
  });

  it('stays healthy for a kill-switched worker that is intentionally not running', async () => {
    // Kill switch on => not consuming, but still a live process that should keep beating,
    // gated only on its Redis reachability. isRunning() is legitimately false here.
    const connection = { ping: vi.fn(() => Promise.resolve('PONG')) };
    const probe = createWorkerLivenessProbe({
      worker: { isRunning: () => false },
      connection,
      shouldConsume: false,
    });

    await expect(probe()).resolves.toBe(true);
    expect(connection.ping).toHaveBeenCalledTimes(1);
  });
});

describe('worker heartbeat closes the dead-consumer hole', () => {
  it('sends NO heartbeat when the run loop has died, even though a producer connection is healthy', async () => {
    const logger = silentLogger();
    const workerPing = vi.fn((_url: string) => Promise.resolve());
    // The side/producer connection the old code probed — perfectly healthy, and irrelevant.
    const queueConnection = { ping: vi.fn(() => Promise.resolve('PONG')) };
    const workerConnection = { ping: vi.fn(() => Promise.resolve('PONG')) };

    const heartbeat = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 1_000,
      logger,
      ping: workerPing,
      isHealthy: createWorkerLivenessProbe({
        worker: { isRunning: () => false },
        connection: workerConnection,
        shouldConsume: true,
      }),
      scheduler: noopScheduler(),
    });

    await heartbeat.beat();

    expect(workerPing).not.toHaveBeenCalled();
    // The producer connection is never consulted for worker liveness anymore.
    expect(queueConnection.ping).not.toHaveBeenCalled();
  });

  it('sends NO heartbeat when the consuming connection is unhealthy though a producer connection responds', async () => {
    const logger = silentLogger();
    const workerPing = vi.fn((_url: string) => Promise.resolve());
    const queueConnection = { ping: vi.fn(() => Promise.resolve('PONG')) };
    const workerConnection = { ping: vi.fn(() => Promise.reject(new Error('redis gone'))) };

    const heartbeat = startLivenessHeartbeat({
      component: 'worker',
      url: WORKER_URL,
      intervalMs: 1_000,
      logger,
      ping: workerPing,
      isHealthy: createWorkerLivenessProbe({
        worker: { isRunning: () => true },
        connection: workerConnection,
        shouldConsume: true,
      }),
      scheduler: noopScheduler(),
    });

    await heartbeat.beat();

    expect(workerPing).not.toHaveBeenCalled();
    expect(queueConnection.ping).not.toHaveBeenCalled();
  });
});
