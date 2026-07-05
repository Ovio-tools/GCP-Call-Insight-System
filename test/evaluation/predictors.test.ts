import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import type { ClassifyModelClient, ClassifyModelResult } from '../../src/anthropic/client.js';
import { createClassifyPredictor } from '../../src/evaluation/predictors.js';
import type { LabeledExampleRow } from '../../src/db/schemas/labeled-examples.js';

const NOW = new Date('2026-07-05T06:00:00.000Z');

function silentLogger(): Logger {
  const noop = (): void => undefined;
  const l = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
  } as unknown as Logger;
  (l as unknown as { child: () => Logger }).child = () => l;
  return l;
}

function example(callId: string): LabeledExampleRow {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    operator_action_id: '00000000-0000-0000-0000-0000000000bb',
    task_type: 'classify',
    review_queue_id: '00000000-0000-0000-0000-0000000000cc',
    call_id: callId,
    held_reason: 'classified_spam',
    reviewer_actor: 'r',
    redacted_input: 'a redacted transcript',
    expected_output: { bucket: 'spam' },
    source_prompt_version: 'classify-v1',
    prompt_version_source: 'current_constant',
    source_schema_version: null,
    model_id: 'haiku',
    model_id_source: 'model_invocations',
    eval_set_version: 1,
    pii_gate_version: 1,
    created_at: NOW,
  };
}

function fakeClient(result: ClassifyModelResult): ClassifyModelClient {
  return { classify: () => Promise.resolve(result) };
}

describe.skipIf(!hasTestDb)('createClassifyPredictor (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  const CALL = 'pred63-call';

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM model_invocations WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, ['2026-07-05']);
  }

  async function seedCall(): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [CALL],
    );
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('records a model_invocations row and returns the predicted bucket', async () => {
    await seedCall();
    const config = makeTestConfig({ CLASSIFY_ENABLED: true, ANTHROPIC_API_KEY: 'x' });
    const predictor = createClassifyPredictor({
      pool: app,
      config,
      getModel: () =>
        fakeClient({
          text: '{"bucket":"customer","reason":"ok"}',
          stopReason: 'end_turn',
          inputTokens: 10,
          outputTokens: 4,
          usagePresent: true,
        }),
      logger: silentLogger(),
      clock: { now: () => NOW.getTime() },
    });
    const result = await predictor(example(CALL));
    expect(result).toEqual({ status: 'ok', value: { bucket: 'customer' } });
    const rows = await owner.query<{ stage: string }>(
      `SELECT stage FROM model_invocations WHERE call_id = $1`,
      [CALL],
    );
    expect(rows.rows[0]!.stage).toBe('evaluation-classify');
  });

  it('refuses with killed when the classify kill switch is off (no model call, no invocation)', async () => {
    await seedCall();
    const config = makeTestConfig({ CLASSIFY_ENABLED: false });
    let called = false;
    const predictor = createClassifyPredictor({
      pool: app,
      config,
      getModel: () => {
        called = true;
        return fakeClient({
          text: '{}',
          stopReason: 'end_turn',
          inputTokens: 0,
          outputTokens: 0,
          usagePresent: true,
        });
      },
      logger: silentLogger(),
      clock: { now: () => NOW.getTime() },
    });
    const result = await predictor(example(CALL));
    expect(result).toEqual({ status: 'killed' });
    expect(called).toBe(false);
    const rows = await owner.query(`SELECT 1 FROM model_invocations WHERE call_id = $1`, [CALL]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses with cost_capped when the daily cap has no headroom', async () => {
    await seedCall();
    const config = makeTestConfig({
      CLASSIFY_ENABLED: true,
      ANTHROPIC_API_KEY: 'x',
      DAILY_MODEL_COST_CAP_USD: 1,
    });
    // Exhaust the day's cap.
    await owner.query(
      `INSERT INTO daily_cost_usage (day, estimated_cost) VALUES ('2026-07-05', 1)
       ON CONFLICT (day) DO UPDATE SET estimated_cost = 1`,
    );
    let called = false;
    const predictor = createClassifyPredictor({
      pool: app,
      config,
      getModel: () => {
        called = true;
        return fakeClient({
          text: '{}',
          stopReason: 'end_turn',
          inputTokens: 0,
          outputTokens: 0,
          usagePresent: true,
        });
      },
      logger: silentLogger(),
      clock: { now: () => NOW.getTime() },
    });
    const result = await predictor(example(CALL));
    expect(result).toEqual({ status: 'cost_capped' });
    expect(called).toBe(false);
  });
});
