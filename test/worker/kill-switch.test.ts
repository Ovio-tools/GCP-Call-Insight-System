import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, sleep, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-%';

/**
 * The kill switch is enforced in the entrypoint: when WORKER_KILL_SWITCH is on it simply
 * never calls `worker.run()`. This test validates that mechanism directly — a built-but-not-
 * started worker (autorun:false) leaves queued jobs untouched, and starting it later drains
 * them — proving the pause drops nothing.
 */
describe.skipIf(!hasTestDb || !hasTestRedis)('kill switch pauses without losing jobs', () => {
  let h!: WorkerHarness;

  beforeAll(async () => {
    await migrate('up');
  });
  beforeEach(() => {
    h = makeWorkerHarness();
  });
  afterEach(async () => {
    await cleanupCalls(h.owner, PATTERN);
    await h.close();
  });

  it('holds jobs in Redis while paused, then processes them when started', async () => {
    const callIds = ['test-wk-ks-1', 'test-wk-ks-2', 'test-wk-ks-3'];
    for (const id of callIds) {
      await h.seedCall(id);
      await enqueueCall(h.queue, id, h.config);
    }

    // Kill switch ON: build the worker but never run() it. Jobs must sit untouched in Redis.
    const worker = h.buildWorker();
    await sleep(300);
    expect(await h.queue.getWaitingCount()).toBe(callIds.length);
    for (const id of callIds) {
      expect((await h.getState(id))?.status).toBe('processing'); // none processed yet
    }

    // Kill switch OFF: start consuming. The previously-queued jobs drain — nothing was lost.
    void worker.run();
    try {
      await waitFor(
        async () => {
          const states = await Promise.all(callIds.map((id) => h.getState(id)));
          return states.every((s) => s?.status === 'completed');
        },
        { label: 'all queued jobs processed after resume', timeoutMs: 8000 },
      );
    } finally {
      await worker.close();
    }

    expect(await h.queue.getWaitingCount()).toBe(0);
  });
});
