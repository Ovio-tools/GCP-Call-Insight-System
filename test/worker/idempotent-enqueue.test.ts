import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PIPELINE_STAGES } from '../../src/pipeline/stages.js';
import { enqueueCall, jobIdForCall } from '../../src/queue/pipeline-queue.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-%';

describe.skipIf(!hasTestDb || !hasTestRedis)('idempotent enqueue', () => {
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
  afterAll(async () => {
    // pools/connections are per-harness; nothing global to tear down.
  });

  it('runs the pipeline once when the same call_id is enqueued twice', async () => {
    const callId = 'test-wk-idem-once';
    await h.seedCall(callId);

    await enqueueCall(h.queue, callId, h.config);
    await enqueueCall(h.queue, callId, h.config); // duplicate collapses to the same jobId

    const worker = h.buildWorker();
    void worker.run();
    try {
      await waitFor(async () => (await h.getState(callId))?.status === 'completed', {
        label: 'call completed',
      });
    } finally {
      await worker.close();
    }

    // One execution → exactly one advance-chain (one processing_log row per stage).
    const logs = await listByCall(h.app, callId);
    expect(logs).toHaveLength(PIPELINE_STAGES.length);
  });

  it('collapses duplicate enqueues of an awkward call_id to a single job', async () => {
    // A call id with characters BullMQ/Redis treat specially — must still dedup and round-trip.
    const callId = 'test-wk-idem-weird::a/b space\n😀';
    await h.seedCall(callId);

    await enqueueCall(h.queue, callId, h.config);
    await enqueueCall(h.queue, callId, h.config);

    // No worker running: prove the queue holds exactly one job for this call.
    expect(await h.queue.getWaitingCount()).toBe(1);

    const job = await h.queue.getJob(jobIdForCall(callId));
    expect(job?.data.callId).toBe(callId); // original id preserved in the payload
  });
});
