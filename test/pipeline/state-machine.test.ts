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
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
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
});
