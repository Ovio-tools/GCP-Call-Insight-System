import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createRootLogger } from '../../src/logging/logger.js';
import { runPipeline } from '../_run-pipeline.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { metadataPreFilterHandler } from '../../src/pipeline/metadata-prefilter.js';
import { getCallState, upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-mpf-%';
const logger = createRootLogger({ level: 'silent', name: 'test-mpf' });

describe.skipIf(!hasTestDb)('metadata pre-filter short-circuit', () => {
  let owner!: Pool;
  let app!: Pool;
  let fetchCalls = 0;

  // Real pre-filter handler + a spy standing in for the (not-yet-built) transcript stage.
  const handlers: StageHandlers = {
    ...defaultStageHandlers,
    'metadata-pre-filter': metadataPreFilterHandler,
    'fetch-transcript': () => {
      fetchCalls += 1;
      return Promise.resolve();
    },
  };

  const seed = (callId: string, sourceMetadata: unknown): Promise<unknown> =>
    upsertCallState(app, {
      callId,
      source: 'test',
      sourceMetadata: sourceMetadata as never,
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    fetchCalls = 0;
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('drops a junk call and never reaches fetch-transcript', async () => {
    const callId = 'test-mpf-drop';
    await seed(callId, { duration: 0 });

    await runPipeline(app, callId, logger, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('skipped');
    expect(state?.drop_reason).toBe('zero_duration');
    expect(state?.current_stage).toBe('metadata-pre-filter'); // never advanced
    expect(fetchCalls).toBe(0); // transcript stage never invoked

    // The row is NOT deleted, and exactly one skipped log row exists.
    expect(state).toBeDefined();
    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
  });

  it('passes a real call through to fetch-transcript and beyond', async () => {
    const callId = 'test-mpf-pass';
    await seed(callId, { duration: 120, direction: 'inbound' });

    await runPipeline(app, callId, logger, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('completed');
    expect(state?.drop_reason).toBeNull();
    expect(fetchCalls).toBe(1); // transcript stage WAS invoked
  });

  it('is a no-op on re-run of a skipped call (no new log rows)', async () => {
    const callId = 'test-mpf-rerun';
    await seed(callId, { duration: 0 });
    await runPipeline(app, callId, logger, handlers);
    const before = (await listByCall(app, callId)).length;

    await runPipeline(app, callId, logger, handlers);

    expect((await listByCall(app, callId)).length).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  it('throws on a corrupt skipped row (skipped status at a non-skip stage)', async () => {
    const callId = 'test-mpf-corrupt';
    await seed(callId, { duration: 0 });
    // Craft an inconsistent terminal row: skipped + a reason, but current_stage is 'redact'
    // (not a skip-stage). The biconditional CHECK still holds (skipped ⇔ reason), so this
    // row is insertable — the runner must reject it rather than silently no-op.
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration', current_stage='redact'
        WHERE call_id=$1`,
      [callId],
    );

    await expect(runPipeline(app, callId, logger, handlers)).rejects.toThrow(/inconsistent/i);
  });
});

// Direct handler-contract tests (requested in code review of Task 7): the handler reads
// call_state, maps the pure decision to a StageResult, and does NOT itself write 'skipped'
// (the runner does). Distinct from the runner integration above.
describe.skipIf(!hasTestDb)('metadataPreFilterHandler contract', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, 'test-mpfh-%');
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('returns a drop StageResult for a junk call and does not write skipped itself', async () => {
    const callId = 'test-mpfh-drop';
    await upsertCallState(app, {
      callId,
      source: 'test',
      sourceMetadata: { duration: 0 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    const result = await metadataPreFilterHandler({
      callId,
      stage: 'metadata-pre-filter',
      logger,
      pool: app,
    });
    expect(result).toEqual({ action: 'drop', reason: 'zero_duration' });
    // The handler only decides; the runner performs the skip. Row is still processing.
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('processing');
  });

  it('returns a continue StageResult for a real call', async () => {
    const callId = 'test-mpfh-pass';
    await upsertCallState(app, {
      callId,
      source: 'test',
      sourceMetadata: { duration: 120, direction: 'inbound' },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    const result = await metadataPreFilterHandler({
      callId,
      stage: 'metadata-pre-filter',
      logger,
      pool: app,
    });
    expect(result).toEqual({ action: 'continue' });
  });

  it('throws when the call_state row is missing', async () => {
    await expect(
      metadataPreFilterHandler({
        callId: 'test-mpfh-missing',
        stage: 'metadata-pre-filter',
        logger,
        pool: app,
      }),
    ).rejects.toThrow(/vanished before metadata pre-filter/i);
  });
});
