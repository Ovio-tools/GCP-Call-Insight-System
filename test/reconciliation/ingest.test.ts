import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import {
  createPgReconciliationIngest,
  RECONCILIATION_SOURCE,
} from '../../src/reconciliation/run.js';
import {
  advanceStage,
  getCallState,
  holdCall,
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
import {
  jobIdForCall,
  PIPELINE_JOB_NAME,
  type PipelineJobData,
} from '../../src/queue/pipeline-queue.js';
import { recordDeadLetter } from '../../src/db/repositories/dead-letter-repo.js';
import { PIPELINE_STAGES, STATUS_PROCESSING } from '../../src/pipeline/stages.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-rc-%';

/** A BullMQ queue stub capturing enqueues; the real Queue is exercised in the queue suite. */
function fakeQueue(): { queue: Queue<PipelineJobData>; add: ReturnType<typeof vi.fn> } {
  const add = vi.fn((_name: string, _data: unknown, _opts: unknown) => Promise.resolve());
  return { queue: { add } as unknown as Queue<PipelineJobData>, add };
}

/** A queue whose add always fails — the Redis-died-mid-run case. */
function brokenQueue(): Queue<PipelineJobData> {
  return {
    add: vi.fn(() => Promise.reject(new Error('redis connection lost'))),
  } as unknown as Queue<PipelineJobData>;
}

describe.skipIf(!hasTestDb)('createPgReconciliationIngest', () => {
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

  const makeIngest = (queue: Queue<PipelineJobData> = fakeQueue().queue) =>
    createPgReconciliationIngest({ pool: app, queue, config: makeTestConfig() });

  it('ingestGap seeds call_state at the first stage and enqueues keyed by call_id', async () => {
    const callId = 'test-rc-gap';
    const { queue, add } = fakeQueue();
    const ingest = createPgReconciliationIngest({ pool: app, queue, config: makeTestConfig() });

    await ingest.ingestGap({ callId, state: 'hangup', direction: 'inbound', duration: 63 });

    const row = await getCallState(app, callId);
    expect(row).toMatchObject({
      call_id: callId,
      source: RECONCILIATION_SOURCE,
      current_stage: PIPELINE_STAGES[0],
      status: STATUS_PROCESSING,
      source_metadata: { state: 'hangup', direction: 'inbound', duration: 63 },
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      PIPELINE_JOB_NAME,
      { callId },
      expect.objectContaining({ jobId: jobIdForCall(callId) }),
    );
  });

  it('alreadyInPipeline is true for an advanced call and for a held call', async () => {
    const advanced = 'test-rc-advanced';
    await upsertCallState(app, {
      callId: advanced,
      source: 'dialpad-webhook',
      currentStage: PIPELINE_STAGES[0],
      status: STATUS_PROCESSING,
    });
    await advanceStage(app, {
      callId: advanced,
      fromStage: PIPELINE_STAGES[0],
      toStage: PIPELINE_STAGES[1],
      logEntry: { stage: PIPELINE_STAGES[0], outcome: 'ok' },
    });

    const held = 'test-rc-held';
    await upsertCallState(app, {
      callId: held,
      source: 'dialpad-webhook',
      currentStage: 'redact',
      status: STATUS_PROCESSING,
    });
    await holdCall(app, { callId: held, atStage: 'redact', heldReason: 'redaction_failed' });

    const ingest = makeIngest();
    expect(await ingest.alreadyInPipeline(advanced)).toBe(true);
    expect(await ingest.alreadyInPipeline(held)).toBe(true);
  });

  it('alreadyInPipeline is false for a row still sitting un-advanced at the first stage', async () => {
    // The seed-then-enqueue failure residue: call_state exists but no job was ever created.
    // Such a row must NOT shield the call from the sweep, whatever service seeded it.
    for (const [callId, source] of [
      ['test-rc-seed-rec', RECONCILIATION_SOURCE],
      ['test-rc-seed-hook', 'dialpad-webhook'],
    ] as const) {
      await upsertCallState(app, {
        callId,
        source,
        currentStage: PIPELINE_STAGES[0],
        status: STATUS_PROCESSING,
      });
    }

    const ingest = makeIngest();
    expect(await ingest.alreadyInPipeline('test-rc-seed-rec')).toBe(false);
    expect(await ingest.alreadyInPipeline('test-rc-seed-hook')).toBe(false);
    expect(await ingest.alreadyInPipeline('test-rc-absent')).toBe(false);
  });

  it('alreadyInPipeline is true for a dead-lettered call even if its row never advanced', async () => {
    // A job that exhausted retries while still at the first stage belongs to the manual
    // re-drive path (dead_letter + DEAD_LETTER_CREATED alert). The sweep must not treat it
    // as a gap and quietly restart it.
    const callId = 'test-rc-dead';
    await upsertCallState(app, {
      callId,
      source: 'dialpad-webhook',
      currentStage: PIPELINE_STAGES[0],
      status: STATUS_PROCESSING,
    });
    await recordDeadLetter(app, {
      callId,
      jobPayload: { callId },
      errorCode: 'QUEUE_RETRY_EXHAUSTED',
      rootCauseCategory: 'QUEUE_RETRY_EXHAUSTED',
    });

    const ingest = makeIngest();
    expect(await ingest.alreadyInPipeline(callId)).toBe(true);
  });

  it('an enqueue failure does not strand the call: the next sweep still sees a gap and enqueues it', async () => {
    const callId = 'test-rc-strand';
    const failing = makeIngest(brokenQueue());

    await expect(failing.ingestGap({ callId, state: 'hangup' })).rejects.toThrow(
      'redis connection lost',
    );

    // The seed row survives (no destructive rollback in the per-call path)…
    expect(await getCallState(app, callId)).toBeDefined();
    // …but it does not count as "in the pipeline", so the next sweep retries it.
    const { queue, add } = fakeQueue();
    const retry = createPgReconciliationIngest({ pool: app, queue, config: makeTestConfig() });
    expect(await retry.alreadyInPipeline(callId)).toBe(false);
    await retry.ingestGap({ callId, state: 'hangup' });
    expect(add).toHaveBeenCalledWith(
      PIPELINE_JOB_NAME,
      { callId },
      expect.objectContaining({ jobId: jobIdForCall(callId) }),
    );
  });

  it('rescuing an existing seed preserves the original row rather than overwriting it', async () => {
    // A webhook-seeded call whose enqueue failed: reconciliation re-enqueues it but must not
    // rewrite the row's provenance (insert-if-absent, never upsert-over).
    const callId = 'test-rc-rescue';
    await upsertCallState(app, {
      callId,
      source: 'dialpad-webhook',
      sourceMetadata: { direction: 'inbound' },
      currentStage: PIPELINE_STAGES[0],
      status: STATUS_PROCESSING,
    });

    const { queue, add } = fakeQueue();
    const ingest = createPgReconciliationIngest({ pool: app, queue, config: makeTestConfig() });
    await ingest.ingestGap({ callId, state: 'hangup', duration: 5 });

    expect(add).toHaveBeenCalledTimes(1);
    const row = await getCallState(app, callId);
    expect(row).toMatchObject({
      source: 'dialpad-webhook',
      source_metadata: { direction: 'inbound' },
    });
  });
});
