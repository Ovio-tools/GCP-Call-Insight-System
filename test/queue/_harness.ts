import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';
import type { Config } from '../../src/config/schema.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { createPipelineQueue, type PipelineJobData } from '../../src/queue/pipeline-queue.js';
import { createPipelineWorker } from '../../src/worker/worker.js';
import type { StageHandlers } from '../../src/pipeline/stages.js';
import { upsertCallState, getCallState } from '../../src/db/repositories/call-state-repo.js';
import { STATUS_PROCESSING } from '../../src/pipeline/stages.js';
import { makePool } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { makeQueueConnection } from './_redis.js';
import { makeTestConfig } from '../_config.js';

/** Unique queue-name suffix per harness so serial tests never share BullMQ state. */
let seq = 0;

const silentLogger = createRootLogger({ level: 'silent', name: 'test-worker' });

/**
 * Build a self-contained worker test rig: a unique queue, an app pool for DAL calls, an owner
 * pool for setup/cleanup, and small retry/backoff so retry paths run in milliseconds. Every
 * Redis/PG resource opened here is released by `close()`.
 */
export function makeWorkerHarness(overrides: Partial<Config> = {}): WorkerHarness {
  seq += 1;
  const queueName = `test-pipeline-${process.pid}-${seq}`;
  const config: Config = makeTestConfig({
    SERVICE_NAME: 'test-worker',
    WORKER_QUEUE_NAME: queueName,
    WORKER_CONCURRENCY: 4,
    WORKER_MAX_ATTEMPTS: 3,
    WORKER_BACKOFF_MS: 10,
    ...overrides,
  });

  const owner = makePool();
  const app = makeAppPool();
  const queueConnection = makeQueueConnection();
  const queue = createPipelineQueue(config, queueConnection);

  const workerConnections: Redis[] = [];

  return {
    config,
    owner,
    app,
    queue,
    /** Seed a call at the first stage so the pipeline has somewhere to start. */
    async seedCall(callId: string): Promise<void> {
      await upsertCallState(app, {
        callId,
        source: 'test',
        currentStage: 'metadata-pre-filter',
        status: STATUS_PROCESSING,
      });
    },
    async getState(callId: string) {
      return getCallState(app, callId);
    },
    /** Build (but do not start) a worker. Call `.run()` on it to begin consuming. */
    buildWorker(handlers?: StageHandlers) {
      const workerConnection = makeQueueConnection();
      workerConnections.push(workerConnection);
      return createPipelineWorker(config, app, workerConnection, {
        logger: silentLogger,
        ...(handlers ? { handlers } : {}),
      });
    },
    async close(): Promise<void> {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      await queueConnection.quit().catch(() => {});
      for (const c of workerConnections) await c.quit().catch(() => {});
      await app.end();
      await owner.end();
    },
  };
}

export interface WorkerHarness {
  config: Config;
  owner: Pool;
  app: Pool;
  queue: Queue<PipelineJobData>;
  seedCall(callId: string): Promise<void>;
  getState(callId: string): ReturnType<typeof getCallState>;
  buildWorker(handlers?: StageHandlers): ReturnType<typeof createPipelineWorker>;
  close(): Promise<void>;
}

/** Poll `fn` until it returns truthy or the timeout elapses. Fails the test on timeout. */
export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  { timeoutMs = 5000, intervalMs = 25, label = 'condition' }: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}
