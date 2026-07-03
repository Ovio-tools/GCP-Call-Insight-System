import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createRootLogger } from '../../src/logging/logger.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import {
  PIPELINE_STAGES,
  STATUS_COMPLETED,
  STATUS_PROCESSING,
  defaultStageHandlers,
  type StageHandlers,
} from '../../src/pipeline/stages.js';
import {
  advanceStage,
  getCallState,
  holdCall,
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
import { setStatus } from '../../src/db/repositories/review-queue-repo.js';
import type { ReviewStatus } from '../../src/db/enums.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-sm-%';
const logger = createRootLogger({ level: 'silent', name: 'test-sm' });

describe.skipIf(!hasTestDb)('pipeline state machine', () => {
  let owner!: Pool;
  let app!: Pool;

  const seed = (callId: string, stage: string, status = STATUS_PROCESSING): Promise<unknown> =>
    upsertCallState(app, { callId, source: 'test', currentStage: stage, status });

  const loggedStages = async (callId: string): Promise<string[]> =>
    (await listByCall(app, callId)).map((r) => r.stage);

  const handlersWith = (overrides: Partial<StageHandlers>): StageHandlers => ({
    ...defaultStageHandlers,
    ...overrides,
  });

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

  it('walks every stage in order and completes at the final stage', async () => {
    const callId = 'test-sm-full';
    await seed(callId, 'metadata-pre-filter');

    await runPipeline(app, callId, logger);

    const state = await getCallState(app, callId);
    expect(state?.current_stage).toBe('mark-retention-eligible');
    expect(state?.status).toBe(STATUS_COMPLETED);

    // Exactly one processing_log row per stage transition, covering every stage.
    const stages = await loggedStages(callId);
    expect(stages).toHaveLength(PIPELINE_STAGES.length);
    expect(new Set(stages)).toEqual(new Set(PIPELINE_STAGES));
  });

  it('resumes from the persisted current_stage', async () => {
    const callId = 'test-sm-resume';
    await seed(callId, 'redact');

    await runPipeline(app, callId, logger);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe(STATUS_COMPLETED);
    // Only stages from redact onward should have run.
    const expected = PIPELINE_STAGES.slice(PIPELINE_STAGES.indexOf('redact'));
    const stages = await loggedStages(callId);
    expect(new Set(stages)).toEqual(new Set(expected));
  });

  it('is a no-op on an already-completed call (no new log rows)', async () => {
    const callId = 'test-sm-noop';
    await seed(callId, 'metadata-pre-filter');
    await runPipeline(app, callId, logger);
    const before = (await loggedStages(callId)).length;

    await runPipeline(app, callId, logger);

    expect((await loggedStages(callId)).length).toBe(before);
  });

  it('throws when a terminal status is paired with a non-final stage', async () => {
    const callId = 'test-sm-bad-terminal';
    await seed(callId, 'redact', STATUS_COMPLETED);
    await expect(runPipeline(app, callId, logger)).rejects.toThrow(/inconsistent/i);
  });

  it('throws when the starting stage is unknown', async () => {
    const callId = 'test-sm-unknown';
    await seed(callId, 'not-a-real-stage');
    await expect(runPipeline(app, callId, logger)).rejects.toThrow(/unknown current_stage/i);
  });

  it('continues when a concurrent runner already advanced past the target', async () => {
    const callId = 'test-sm-stale-ahead';
    await seed(callId, 'metadata-pre-filter');

    // The first handler simulates a concurrent runner moving the call forward, so our own
    // advance hits DAL_STALE_STAGE and must re-verify + resume rather than fail.
    const handlers = handlersWith({
      'metadata-pre-filter': async () => {
        await advanceStage(app, {
          callId,
          fromStage: 'metadata-pre-filter',
          toStage: 'fetch-transcript',
          logEntry: { stage: 'metadata-pre-filter', outcome: 'completed' },
        });
      },
    });

    await runPipeline(app, callId, logger, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe(STATUS_COMPLETED);
    expect(state?.current_stage).toBe('mark-retention-eligible');
  });

  it('throws when the DB stage regressed below the target (real inconsistency)', async () => {
    const callId = 'test-sm-stale-behind';
    await seed(callId, 'classify');

    // The handler pushes current_stage backward, so the advance is stale AND the DB sits
    // below our target — the runner must throw, never silently skip work.
    const handlers = handlersWith({
      classify: async () => {
        await upsertCallState(app, {
          callId,
          source: 'test',
          currentStage: 'redact',
          status: STATUS_PROCESSING,
        });
      },
    });

    await expect(runPipeline(app, callId, logger, handlers)).rejects.toThrow(/inconsistent/i);
  });

  it('defer stops at the stage without advancing or failing (and resumes later)', async () => {
    const callId = 'test-sm-defer';
    await seed(callId, 'fetch-transcript');

    // A stage that defers: the handler has scheduled its own re-run, so the runner stops.
    const deferHandlers = handlersWith({
      'fetch-transcript': () => Promise.resolve({ action: 'defer' as const }),
    });
    await runPipeline(app, callId, logger, deferHandlers);

    let state = await getCallState(app, callId);
    expect(state?.status).toBe(STATUS_PROCESSING);
    expect(state?.current_stage).toBe('fetch-transcript');
    // No 'completed' advance log was written for the deferred stage.
    expect(await loggedStages(callId)).not.toContain('fetch-transcript');

    // On the delayed re-run the transcript is ready: the pipeline resumes and completes.
    await runPipeline(app, callId, logger); // default stubs continue
    state = await getCallState(app, callId);
    expect(state?.status).toBe(STATUS_COMPLETED);
  });

  it('hold sets the call aside (held + review_queue) and is a terminal no-op on re-run', async () => {
    const callId = 'test-sm-hold';
    await seed(callId, 'fetch-transcript');

    const holdHandlers = handlersWith({
      'fetch-transcript': () =>
        Promise.resolve({
          action: 'hold' as const,
          reason: 'missing_transcript' as const,
          errorCode: 'DIALPAD_TRANSCRIPT_MISSING' as const,
        }),
    });
    await runPipeline(app, callId, logger, holdHandlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held');
    expect(state?.current_stage).toBe('fetch-transcript');
    const reviews = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows[0]?.n).toBe('1');

    // Re-enqueue of a held call: terminal no-op, the hold handler must NOT run again.
    const heldLogsBefore = (await loggedStages(callId)).length;
    let ran = false;
    await runPipeline(
      app,
      callId,
      logger,
      handlersWith({
        'fetch-transcript': () => {
          ran = true;
          return Promise.resolve({ action: 'continue' as const });
        },
      }),
    );
    expect(ran).toBe(false);
    expect((await loggedStages(callId)).length).toBe(heldLogsBefore);
  });

  it("forwards a hold action's failureSnapshot onto the held processing_log row", async () => {
    const callId = 'test-sm-hold-snapshot';
    await seed(callId, 'fetch-transcript');

    const snapshot = {
      error_code: 'DIALPAD_TRANSCRIPT_MISSING',
      root_cause_category: 'DIALPAD_TRANSCRIPT_MISSING',
      severity: 'low',
      impact: 'held for review',
      processing_state: 'degraded',
      remediation_now: 'review the held call',
      remediation_fix: 'same as the immediate step',
      data_safe: true,
      calls_state: 'held',
      owner: 'OVIO on-call',
      runbook_ref: 'runbook#dialpad-transcript-missing',
      context: { call_id: callId, stage: 'fetch-transcript' },
    };

    await runPipeline(
      app,
      callId,
      logger,
      handlersWith({
        'fetch-transcript': () =>
          Promise.resolve({
            action: 'hold' as const,
            reason: 'missing_transcript' as const,
            errorCode: 'DIALPAD_TRANSCRIPT_MISSING' as const,
            failureSnapshot: snapshot,
          }),
      }),
    );

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]?.failure_snapshot).toEqual(snapshot);
  });

  it('synthesizes a full failure_snapshot for a hold carrying an errorCode but no explicit snapshot', async () => {
    const callId = 'test-sm-hold-synth';
    await seed(callId, 'fetch-transcript');

    await runPipeline(
      app,
      callId,
      logger,
      handlersWith({
        'fetch-transcript': () =>
          Promise.resolve({
            action: 'hold' as const,
            reason: 'missing_transcript' as const,
            errorCode: 'DIALPAD_TRANSCRIPT_MISSING' as const,
          }),
      }),
    );

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
    const snap = held[0]?.failure_snapshot as Record<string, unknown>;
    expect(snap).toMatchObject({
      error_code: 'DIALPAD_TRANSCRIPT_MISSING',
      root_cause_category: 'DIALPAD_TRANSCRIPT_MISSING',
      runbook_ref: 'runbook#dialpad-transcript-missing',
      calls_state: 'held',
      context: { call_id: callId, stage: 'fetch-transcript' },
    });
    // Every §4 field is present.
    for (const key of [
      'severity',
      'impact',
      'processing_state',
      'remediation_now',
      'remediation_fix',
      'data_safe',
      'owner',
    ]) {
      expect(snap).toHaveProperty(key);
    }
  });

  it('leaves failure_snapshot null for a hold with no errorCode (a routing hold, not a failure)', async () => {
    const callId = 'test-sm-hold-noerr';
    await seed(callId, 'classify');

    await runPipeline(
      app,
      callId,
      logger,
      handlersWith({
        classify: () =>
          Promise.resolve({ action: 'hold' as const, reason: 'classified_spam' as const }),
      }),
    );

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]?.failure_snapshot).toBeNull();
  });

  it('rejects a corrupt held row sitting at an unknown stage', async () => {
    const callId = 'test-sm-held-badstage';
    await seed(callId, 'not-a-real-stage', 'held');
    await expect(runPipeline(app, callId, logger)).rejects.toThrow(/inconsistent/i);
  });

  it('rejects a held row with no review_queue record (lost from review)', async () => {
    const callId = 'test-sm-held-noreview';
    // A held status at a valid stage but WITHOUT the review row holdCall would have written.
    await seed(callId, 'fetch-transcript', 'held');
    await expect(runPipeline(app, callId, logger)).rejects.toThrow(/inconsistent/i);
  });

  // Hold the call (open review), then move its review to `reviewStatus`.
  const holdThenSetReview = async (callId: string, reviewStatus: ReviewStatus): Promise<void> => {
    await seed(callId, 'fetch-transcript');
    await holdCall(app, { callId, atStage: 'fetch-transcript', heldReason: 'missing_transcript' });
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    await setStatus(app, rows[0]!.id, reviewStatus);
  };

  it('held + in_review review is a no-op (still an active hold)', async () => {
    const callId = 'test-sm-held-inreview';
    await holdThenSetReview(callId, 'in_review');
    await runPipeline(app, callId, logger); // must not throw
    expect((await getCallState(app, callId))?.status).toBe('held');
  });

  it.each(['resolved', 'unresolvable'] as const)(
    'rejects a held row whose only review is %s (no active hold, call_state not moved off held)',
    async (reviewStatus) => {
      const callId = `test-sm-held-${reviewStatus}`;
      await holdThenSetReview(callId, reviewStatus);
      await expect(runPipeline(app, callId, logger)).rejects.toThrow(/inconsistent/i);
    },
  );

  it("lands a continue action detail on that stage's completed processing_log row", async () => {
    const callId = 'test-sm-continue-detail';
    await seed(callId, 'classify');

    const handlers = handlersWith({
      classify: () =>
        Promise.resolve({ action: 'continue' as const, detail: { bucket: 'customer' } }),
    });
    await runPipeline(app, callId, logger, handlers);

    const logs = await listByCall(app, callId);
    const classifyLog = logs.find((r) => r.stage === 'classify' && r.outcome === 'completed');
    expect(classifyLog?.detail).toEqual({ bucket: 'customer' });
  });

  it('a bare continue action (no detail) writes no detail, same as a void return', async () => {
    const callId = 'test-sm-continue-no-detail';
    await seed(callId, 'classify');

    const handlers = handlersWith({
      classify: () => Promise.resolve({ action: 'continue' as const }),
    });
    await runPipeline(app, callId, logger, handlers);

    const logs = await listByCall(app, callId);
    const classifyLog = logs.find((r) => r.stage === 'classify' && r.outcome === 'completed');
    expect(classifyLog?.detail).toBeNull();
  });
});
