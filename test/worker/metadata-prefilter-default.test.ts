import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-mpf-%';

describe.skipIf(!hasTestDb || !hasTestRedis)('worker default uses the metadata pre-filter', () => {
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

  it('skips a junk call before later stages with NO injected handlers', async () => {
    const callId = 'test-wk-mpf-drop';
    // Seed a drop-worthy call directly (harness.seedCall does not take source_metadata).
    await upsertCallState(h.app, {
      callId,
      source: 'test',
      sourceMetadata: { duration: 0 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    await enqueueCall(h.queue, callId, h.config);

    // buildWorker() with NO handlers → the worker's productionStageHandlers default,
    // which must carry the real metadata-pre-filter handler. If worker.ts regressed to the
    // stub set, the call would sail through to 'completed' and this test would fail.
    const worker = h.buildWorker();
    void worker.run();
    try {
      await waitFor(async () => (await h.getState(callId))?.status === 'skipped', {
        label: 'call skipped by worker default pre-filter',
      });
    } finally {
      await worker.close();
    }

    const state = await h.getState(callId);
    expect(state?.status).toBe('skipped');
    expect(state?.drop_reason).toBe('zero_duration');
    expect(state?.current_stage).toBe('metadata-pre-filter');
  });
});
