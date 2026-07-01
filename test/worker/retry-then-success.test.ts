import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-%';

describe.skipIf(!hasTestDb || !hasTestRedis)('retry then success', () => {
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

  it('recovers on its own after transient stage failures', async () => {
    const callId = 'test-wk-retry-ok';
    await h.seedCall(callId);
    await enqueueCall(h.queue, callId, h.config);

    // `redact` throws on its first two invocations, then succeeds — exercising BullMQ retries
    // and the runner's resume-from-current-stage behaviour (attempts capped at 3 in the harness).
    let redactCalls = 0;
    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      redact: () => {
        redactCalls += 1;
        return redactCalls < 3
          ? Promise.reject(new Error('transient redact failure'))
          : Promise.resolve();
      },
    };

    const worker = h.buildWorker(handlers);
    void worker.run();
    try {
      await waitFor(async () => (await h.getState(callId))?.status === 'completed', {
        label: 'call completed after retries',
      });
    } finally {
      await worker.close();
    }

    const state = await h.getState(callId);
    expect(state?.status).toBe('completed');
    expect(redactCalls).toBe(3); // failed twice, succeeded on the third attempt

    // No dead-letter row: the job recovered without intervention.
    const dl = await h.owner.query('SELECT 1 FROM dead_letter WHERE call_id = $1', [callId]);
    expect(dl.rowCount).toBe(0);
  });
});
