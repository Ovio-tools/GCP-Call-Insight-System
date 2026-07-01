import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DAL_STALE_STAGE, DalError, repositories } from '../../src/db/index.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';

const PATTERN = 'test-adv-%';

/** advanceStage moves the stage AND appends a processing_log row atomically. */
describe.skipIf(!hasTestDb)('atomic stage-advance', () => {
  let owner!: Pool;
  let app!: Pool;

  async function seedCall(callId: string, stage: string): Promise<void> {
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: stage,
      status: 'processing',
    });
  }
  async function logCount(callId: string): Promise<number> {
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM processing_log WHERE call_id = $1`,
      [callId],
    );
    return Number(res.rows[0]?.n);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('advances the stage and appends exactly one processing_log row in one commit', async () => {
    const callId = 'test-adv-ok';
    await seedCall(callId, 'redact');
    const before = await logCount(callId);
    const row = await repositories.callState.advanceStage(app, {
      callId,
      fromStage: 'redact',
      toStage: 'classify',
      logEntry: { stage: 'classify', outcome: 'entered' },
    });
    expect(row.current_stage).toBe('classify');
    expect(await logCount(callId)).toBe(before + 1);
  });

  it('rejects a stale advance (fromStage guard) with DAL_STALE_STAGE and writes no log', async () => {
    const callId = 'test-adv-stale';
    await seedCall(callId, 'classify');
    const before = await logCount(callId);
    await expect(
      repositories.callState.advanceStage(app, {
        callId,
        fromStage: 'redact', // wrong: call is at 'classify'
        toStage: 'extract',
        logEntry: { stage: 'extract', outcome: 'entered' },
      }),
    ).rejects.toMatchObject({ code: DAL_STALE_STAGE });
    const state = await repositories.callState.getCallState(app, callId);
    expect(state?.current_stage).toBe('classify'); // unchanged
    expect(await logCount(callId)).toBe(before); // no orphan log row
  });

  it('rolls back the stage change when the log write fails (atomicity)', async () => {
    const callId = 'test-adv-rollback';
    await seedCall(callId, 'redact');
    const before = await logCount(callId);
    // A bigint detail passes advanceStage's `unknown` gate but fails the processing_log
    // insert's json validation INSIDE the transaction, after the UPDATE ran — proving
    // the committed-in-tx stage change is rolled back when the log write throws.
    await expect(
      repositories.callState.advanceStage(app, {
        callId,
        toStage: 'classify',
        logEntry: { stage: 'classify', outcome: 'entered', detail: 1n as unknown as never },
      }),
    ).rejects.toBeInstanceOf(DalError);
    const state = await repositories.callState.getCallState(app, callId);
    expect(state?.current_stage).toBe('redact'); // rolled back
    expect(await logCount(callId)).toBe(before); // nothing written
  });
});
