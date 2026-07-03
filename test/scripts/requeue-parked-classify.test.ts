import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import {
  findParkedClassifyCalls,
  requeueParkedClassifyCalls,
} from '../../src/scripts/requeue-parked-classify.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { appendLog } from '../../src/db/repositories/processing-log-repo.js';
import { createPgReconciliationIngest, runReconciliation } from '../../src/reconciliation/run.js';
import type { RecentCall } from '../../src/dialpad/client/index.js';
import {
  jobIdForCall,
  PIPELINE_JOB_NAME,
  type PipelineJobData,
} from '../../src/queue/pipeline-queue.js';
import { STATUS_PROCESSING } from '../../src/pipeline/stages.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-rqc-%';

/** A BullMQ queue stub capturing enqueues; the real Queue is exercised in the queue suite. */
function fakeQueue(): { queue: Queue<PipelineJobData>; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn((_name: string, _data: unknown, _opts: unknown) => Promise.resolve());
  return { queue: { add } as unknown as Queue<PipelineJobData>, add };
}

/** Seed a call parked at classify by the kill switch: call_state at stage 'classify' /
 * status 'processing', with its LATEST classify processing_log row being the
 * `classify_disabled` deferred marker (exactly what parkDisabled writes). */
async function seedParkedClassify(pool: Pool, callId: string): Promise<void> {
  await upsertCallState(pool, {
    callId,
    source: 'dialpad-webhook',
    currentStage: 'classify',
    status: STATUS_PROCESSING,
  });
  await appendLog(pool, {
    callId,
    stage: 'classify',
    outcome: 'deferred',
    detail: { reason: 'classify_disabled' },
  });
}

describe.skipIf(!hasTestDb)('findParkedClassifyCalls', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('returns EXACTLY the parked classify calls, excluding every decoy', async () => {
    const parkedA = 'test-rqc-parked-a';
    const parkedB = 'test-rqc-parked-b';
    await seedParkedClassify(app, parkedA);
    await seedParkedClassify(app, parkedB);

    // Decoy 1: at classify/processing, but its LATEST classify log is a normal 'held'
    // outcome (not classify_disabled) — a genuinely-classified-then-held call.
    const decoyHeld = 'test-rqc-decoy-held';
    await upsertCallState(app, {
      callId: decoyHeld,
      source: 'dialpad-webhook',
      currentStage: 'classify',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyHeld,
      stage: 'classify',
      outcome: 'held',
      detail: { reason: 'ambiguous' },
    });

    // Decoy 2: parked earlier, but later genuinely processed — a NEWER classify log row
    // exists whose reason is NOT classify_disabled. Must NOT match (latest wins).
    const decoyResumed = 'test-rqc-decoy-resumed';
    await upsertCallState(app, {
      callId: decoyResumed,
      source: 'dialpad-webhook',
      currentStage: 'classify',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyResumed,
      stage: 'classify',
      outcome: 'deferred',
      detail: { reason: 'classify_disabled' },
    });
    await appendLog(app, {
      callId: decoyResumed,
      stage: 'classify',
      outcome: 'ok',
      detail: { classification: 'customer' },
    });

    // Decoy 3: parked classify marker, but call_state has moved past classify (extract).
    const decoyAdvanced = 'test-rqc-decoy-advanced';
    await upsertCallState(app, {
      callId: decoyAdvanced,
      source: 'dialpad-webhook',
      currentStage: 'extract',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyAdvanced,
      stage: 'classify',
      outcome: 'deferred',
      detail: { reason: 'classify_disabled' },
    });

    // Decoy 4: at classify/processing but with NO classify processing_log row at all.
    const decoyNoLog = 'test-rqc-decoy-nolog';
    await upsertCallState(app, {
      callId: decoyNoLog,
      source: 'dialpad-webhook',
      currentStage: 'classify',
      status: STATUS_PROCESSING,
    });

    // Decoy 5: classify_disabled marker but call_state at a stage BEFORE classify.
    const decoyEarly = 'test-rqc-decoy-early';
    await upsertCallState(app, {
      callId: decoyEarly,
      source: 'dialpad-webhook',
      currentStage: 'redact',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyEarly,
      stage: 'classify',
      outcome: 'deferred',
      detail: { reason: 'classify_disabled' },
    });

    const found = await findParkedClassifyCalls(app);
    expect([...found].sort()).toEqual([parkedA, parkedB].sort());
  });

  it('requeueParkedClassifyCalls enqueues each parked call exactly once, keyed by call_id', async () => {
    const parkedA = 'test-rqc-enq-a';
    const parkedB = 'test-rqc-enq-b';
    await seedParkedClassify(app, parkedA);
    await seedParkedClassify(app, parkedB);

    const { queue, add } = fakeQueue();
    const count = await requeueParkedClassifyCalls({ pool: app, queue, config: makeTestConfig() });

    expect(count).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
    for (const callId of [parkedA, parkedB]) {
      expect(add).toHaveBeenCalledWith(
        PIPELINE_JOB_NAME,
        { callId },
        expect.objectContaining({ jobId: jobIdForCall(callId) }),
      );
    }
  });
});

describe.skipIf(!hasTestDb)('reconciliation does not rescue a parked classify call', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('the reconciliation sweep does NOT enqueue a parked classify call (proving the gap)', async () => {
    const parked = 'test-rqc-recon-parked';
    await seedParkedClassify(app, parked);

    const config = makeTestConfig({ RECONCILIATION_CHECK_URL: undefined });
    const { queue, add } = fakeQueue();
    // Drive the REAL reconciliation selection logic (createPgReconciliationIngest) against
    // a capturing queue; Dialpad lists the parked call as recently concluded.
    const ingest = createPgReconciliationIngest({ pool: app, queue, config });
    const listedCall: RecentCall = { callId: parked, state: 'hangup' };

    const summary = await runReconciliation({
      config,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        fatal: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
      } as unknown as Parameters<typeof runReconciliation>[0]['logger'],
      client: {
        listRecentlyConcludedCalls: () => Promise.resolve({ calls: [listedCall] }),
      },
      ...ingest,
      // Deterministic clock: the parked call has no endedAt, and 'hangup' is terminal, so it
      // is swept — the point is that alreadyInPipeline still excludes it.
      clock: { now: () => Date.now() },
    });

    // A parked classify call has a non-pristine call_state row (stage 'classify', not the
    // first stage), so alreadyInPipeline returns true and the sweep never enqueues it.
    expect(add).not.toHaveBeenCalled();
    expect(summary.gapsEnqueued).toBe(0);

    // Sanity: the requeue script DOES pick it up — this is the gap the script fills.
    expect(await findParkedClassifyCalls(app)).toEqual([parked]);
  });
});
