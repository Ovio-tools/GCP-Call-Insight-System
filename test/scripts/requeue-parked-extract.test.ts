import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import {
  findParkedExtractCalls,
  requeueParkedExtractCalls,
} from '../../src/scripts/requeue-parked-extract.js';
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

const PATTERN = 'test-rqe-%';

/** A BullMQ queue stub capturing enqueues; the real Queue is exercised in the queue suite. */
function fakeQueue(): { queue: Queue<PipelineJobData>; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn((_name: string, _data: unknown, _opts: unknown) => Promise.resolve());
  return { queue: { add } as unknown as Queue<PipelineJobData>, add };
}

/** Seed a call parked at extract by the kill switch: call_state at stage 'extract' /
 * status 'processing', with its LATEST extract processing_log row being the
 * `extract_disabled` deferred marker (exactly what parkDisabled writes). */
async function seedParkedExtract(pool: Pool, callId: string): Promise<void> {
  await upsertCallState(pool, {
    callId,
    source: 'dialpad-webhook',
    currentStage: 'extract',
    status: STATUS_PROCESSING,
  });
  await appendLog(pool, {
    callId,
    stage: 'extract',
    outcome: 'deferred',
    detail: { reason: 'extract_disabled' },
  });
}

describe.skipIf(!hasTestDb)('findParkedExtractCalls', () => {
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

  it('returns EXACTLY the parked extract calls, excluding every decoy', async () => {
    const parkedA = 'test-rqe-parked-a';
    const parkedB = 'test-rqe-parked-b';
    await seedParkedExtract(app, parkedA);
    await seedParkedExtract(app, parkedB);

    // Decoy 1: at extract/processing, but its LATEST extract log is a normal 'held'
    // outcome (not extract_disabled) — a genuinely-extracted-then-held call.
    const decoyHeld = 'test-rqe-decoy-held';
    await upsertCallState(app, {
      callId: decoyHeld,
      source: 'dialpad-webhook',
      currentStage: 'extract',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyHeld,
      stage: 'extract',
      outcome: 'held',
      detail: { reason: 'schema_invalid' },
    });

    // Decoy 2: parked earlier, but later genuinely processed — a NEWER extract log row
    // exists whose reason is NOT extract_disabled. Must NOT match (latest wins).
    const decoyResumed = 'test-rqe-decoy-resumed';
    await upsertCallState(app, {
      callId: decoyResumed,
      source: 'dialpad-webhook',
      currentStage: 'extract',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyResumed,
      stage: 'extract',
      outcome: 'deferred',
      detail: { reason: 'extract_disabled' },
    });
    await appendLog(app, {
      callId: decoyResumed,
      stage: 'extract',
      outcome: 'ok',
      detail: { extracted: true },
    });

    // Decoy 3: parked extract marker, but call_state has moved past extract (store).
    const decoyAdvanced = 'test-rqe-decoy-advanced';
    await upsertCallState(app, {
      callId: decoyAdvanced,
      source: 'dialpad-webhook',
      currentStage: 'store',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyAdvanced,
      stage: 'extract',
      outcome: 'deferred',
      detail: { reason: 'extract_disabled' },
    });

    // Decoy 4: at extract/processing but with NO extract processing_log row at all.
    const decoyNoLog = 'test-rqe-decoy-nolog';
    await upsertCallState(app, {
      callId: decoyNoLog,
      source: 'dialpad-webhook',
      currentStage: 'extract',
      status: STATUS_PROCESSING,
    });

    // Decoy 5: extract_disabled marker but call_state at a stage BEFORE extract.
    const decoyEarly = 'test-rqe-decoy-early';
    await upsertCallState(app, {
      callId: decoyEarly,
      source: 'dialpad-webhook',
      currentStage: 'classify',
      status: STATUS_PROCESSING,
    });
    await appendLog(app, {
      callId: decoyEarly,
      stage: 'extract',
      outcome: 'deferred',
      detail: { reason: 'extract_disabled' },
    });

    const found = await findParkedExtractCalls(app);
    expect([...found].sort()).toEqual([parkedA, parkedB].sort());
  });

  it('requeueParkedExtractCalls enqueues each parked call exactly once, keyed by call_id', async () => {
    const parkedA = 'test-rqe-enq-a';
    const parkedB = 'test-rqe-enq-b';
    await seedParkedExtract(app, parkedA);
    await seedParkedExtract(app, parkedB);

    const { queue, add } = fakeQueue();
    const count = await requeueParkedExtractCalls({ pool: app, queue, config: makeTestConfig() });

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

describe.skipIf(!hasTestDb)('reconciliation does not rescue a parked extract call', () => {
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

  it('the reconciliation sweep does NOT enqueue a parked extract call (proving the gap)', async () => {
    const parked = 'test-rqe-recon-parked';
    await seedParkedExtract(app, parked);

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

    // A parked extract call has a non-pristine call_state row (stage 'extract', not the
    // first stage), so alreadyInPipeline returns true and the sweep never enqueues it.
    expect(add).not.toHaveBeenCalled();
    expect(summary.gapsEnqueued).toBe(0);

    // Sanity: the requeue script DOES pick it up — this is the gap the script fills.
    expect(await findParkedExtractCalls(app)).toEqual([parked]);
  });
});
