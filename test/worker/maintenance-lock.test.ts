import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { enqueueCall, jobIdForCall } from '../../src/queue/pipeline-queue.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { createPipelineWorker } from '../../src/worker/worker.js';
import { createRootLogger } from '../../src/logging/logger.js';
import {
  clearMaintenance,
  isMaintenanceActive,
  pauseQueue,
  resumeQueue,
  setMaintenance,
} from '../../src/key-lifecycle/maintenance-lock.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis, makeQueueConnection } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, sleep, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-maint-%';
const silent = createRootLogger({ level: 'silent', name: 'test-maint' });

describe.skipIf(!hasTestDb || !hasTestRedis)('key-rotation maintenance backstop', () => {
  let h!: WorkerHarness;
  let flag!: Redis;

  beforeAll(async () => {
    await migrate('up');
  });
  beforeEach(() => {
    // Long re-delay so a backstopped job stays in `delayed` for the assertion window.
    h = makeWorkerHarness({ KEY_ROTATION_MAINTENANCE_REQUEUE_DELAY_MS: 60_000 });
    flag = makeQueueConnection();
  });
  afterEach(async () => {
    await clearMaintenance(flag).catch(() => {});
    await flag.quit().catch(() => {});
    await cleanupCalls(h.owner, PATTERN);
    await h.close();
  });

  it('re-delays an already-fetched job WITHOUT incrementing attemptsMade (required gate)', async () => {
    const callId = 'test-maint-attempts';
    await h.seedCall(callId);
    await enqueueCall(h.queue, callId, h.config);
    await setMaintenance(flag);

    const conn = makeQueueConnection();
    const worker = createPipelineWorker(h.config, h.app, conn, {
      logger: silent,
      handlers: defaultStageHandlers,
      isMaintenanceActive: () => isMaintenanceActive(flag),
    });
    void worker.run();
    try {
      // The backstop moved the fetched job into `delayed`.
      await waitFor(async () => (await h.queue.getDelayedCount()) > 0, {
        label: 'job backstopped to delayed',
        timeoutMs: 8000,
      });

      const job = await Job.fromId<unknown, unknown>(h.queue, jobIdForCall(callId));
      // The gate: a maintenance requeue must NOT consume a retry.
      expect(job?.attemptsMade).toBe(0);

      // And it was neither completed nor failed solely due to maintenance.
      expect(await h.queue.getCompletedCount()).toBe(0);
      expect(await h.queue.getFailedCount()).toBe(0);
      const dl = await h.owner.query('SELECT 1 FROM dead_letter WHERE call_id = $1', [callId]);
      expect(dl.rowCount ?? 0).toBe(0);
      const failed = await h.owner.query(
        "SELECT 1 FROM processing_log WHERE call_id = $1 AND outcome = 'failed'",
        [callId],
      );
      expect(failed.rowCount ?? 0).toBe(0);
    } finally {
      await worker.close();
      await conn.quit().catch(() => {});
    }
  });

  it('a globally paused queue keeps a job waiting until resume', async () => {
    const callId = 'test-maint-pause';
    await h.seedCall(callId);

    let ran = 0;
    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      'metadata-pre-filter': async (ctx) => {
        ran += 1;
        return defaultStageHandlers['metadata-pre-filter'](ctx);
      },
    };

    await pauseQueue(h.queue);
    await enqueueCall(h.queue, callId, h.config);

    const conn = makeQueueConnection();
    const worker = createPipelineWorker(h.config, h.app, conn, { logger: silent, handlers });
    void worker.run();
    try {
      // Paused: the job is not consumed.
      await sleep(400);
      expect(ran).toBe(0);
      expect(await h.queue.getActiveCount()).toBe(0);

      // Resume: the job is picked up.
      await resumeQueue(h.queue);
      await waitFor(() => ran > 0, { label: 'job processed after resume', timeoutMs: 8000 });
      expect(ran).toBeGreaterThan(0);
    } finally {
      await worker.close();
      await conn.quit().catch(() => {});
    }
  });
});
