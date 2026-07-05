import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, seedKeyVersion } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import { insertLabeledExample } from '../../src/db/repositories/labeled-examples-repo.js';
import { runEvaluationJob } from '../../src/services/evaluation-run.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../../src/evaluation/version.js';
import type { ClassifyPredictor, ExtractPredictor } from '../../src/evaluation/run-evaluation.js';
import { ConfigError } from '../../src/config/index.js';

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

const NOOP_EXTRACT: ExtractPredictor = () => Promise.resolve({ status: 'error' as const });

describe.skipIf(!hasTestDb)('runEvaluationJob (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  const P = 'evalrun-';

  async function seedClassify(callId: string, actionSuffix: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'classified_spam', now() + interval '1 hour') RETURNING id`,
      [callId],
    );
    const oa = await owner.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'r-${actionSuffix}', 'mark_spam', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [rq.rows[0]!.id],
    );
    await insertLabeledExample(app, {
      operatorActionId: oa.rows[0]!.id,
      taskType: 'classify',
      reviewQueueId: rq.rows[0]!.id,
      callId,
      heldReason: 'classified_spam',
      reviewerActor: 'r',
      redactedInput: 'a redacted transcript body',
      expectedOutput: { bucket: 'spam' },
      sourcePromptVersion: 'classify-v1',
      promptVersionSource: 'current_constant',
      modelId: null,
      modelIdSource: 'none',
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
    });
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM evaluation_reports WHERE eval_set_version = $1`, [
      EVAL_SET_VERSION,
    ]);
    await owner.query(`DELETE FROM labeled_examples WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
      [`${P}%`],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${P}%`]);
  }

  function fakePing(): { ping: (url: string) => Promise<void>; calls: string[] } {
    const calls: string[] = [];
    return { ping: (url) => (calls.push(url), Promise.resolve()), calls };
  }

  const spamClassify: ClassifyPredictor = () =>
    Promise.resolve({ status: 'ok', value: { bucket: 'spam' } });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  async function reportCount(): Promise<number> {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM evaluation_reports WHERE eval_set_version = $1`,
      [EVAL_SET_VERSION],
    );
    return Number(r.rows[0]!.n);
  }

  it('is a no-op when EVALUATION_RUN_ENABLED is false (no report, no ping)', async () => {
    const { ping, calls } = fakePing();
    const report = await runEvaluationJob(app, {
      config: makeTestConfig({ EVALUATION_RUN_ENABLED: false }),
      logger: silentLogger(),
      now: () => NOW,
      ping,
      denyTerms: [],
      predictors: { mode: 'live', classifyPredictor: spamClassify, extractPredictor: NOOP_EXTRACT },
      syncLabels: () => Promise.resolve({ failed: 0 }),
    });
    expect(report).toBeNull();
    expect(await reportCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('throws CONFIG_MISSING_OR_INVALID in staging when enabled but not live (no report)', async () => {
    const { ping, calls } = fakePing();
    await expect(
      runEvaluationJob(app, {
        config: makeTestConfig({
          NODE_ENV: 'staging',
          EVALUATION_RUN_ENABLED: true,
          EVALUATION_LIVE_MODE: false,
          EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
        }),
        logger: silentLogger(),
        now: () => NOW,
        ping,
        denyTerms: [],
        predictors: {
          mode: 'live',
          classifyPredictor: spamClassify,
          extractPredictor: NOOP_EXTRACT,
        },
        syncLabels: () => Promise.resolve({ failed: 0 }),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(await reportCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('aborts (no report, no ping) when the safety-net sync reports operational failures', async () => {
    await seedClassify(`${P}a`, 'a');
    const { ping, calls } = fakePing();
    await expect(
      runEvaluationJob(app, {
        config: makeTestConfig({
          EVALUATION_RUN_ENABLED: true,
          EVALUATION_LIVE_MODE: true,
          EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
        }),
        logger: silentLogger(),
        now: () => NOW,
        ping,
        denyTerms: [],
        predictors: {
          mode: 'live',
          classifyPredictor: spamClassify,
          extractPredictor: NOOP_EXTRACT,
        },
        syncLabels: () => Promise.resolve({ failed: 1 }),
      }),
    ).rejects.toThrow(/label sync failed/i);
    expect(await reportCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('inserts a complete live report and pings the evaluation check', async () => {
    await seedClassify(`${P}a`, 'a');
    await seedClassify(`${P}b`, 'b');
    const { ping, calls } = fakePing();
    const report = await runEvaluationJob(app, {
      config: makeTestConfig({
        EVALUATION_RUN_ENABLED: true,
        EVALUATION_LIVE_MODE: true,
        EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
      }),
      logger: silentLogger(),
      now: () => NOW,
      ping,
      denyTerms: [],
      predictors: { mode: 'live', classifyPredictor: spamClassify, extractPredictor: NOOP_EXTRACT },
      syncLabels: () => Promise.resolve({ failed: 0 }),
    });
    expect(report?.status).toBe('complete');
    const row = await owner.query<Record<string, unknown>>(
      `SELECT * FROM evaluation_reports WHERE eval_set_version = $1`,
      [EVAL_SET_VERSION],
    );
    expect(row.rows[0]!.mode).toBe('live');
    expect(row.rows[0]!.status).toBe('complete');
    expect(calls).toEqual(['https://checks.example.com/eval']);
    // The persisted row, serialized whole, carries no transcript/content field (finding R2-7).
    expect(JSON.stringify(row.rows[0])).not.toContain('a redacted transcript body');
  });

  it('does not ping on a partial (mid-run cost cap) live run', async () => {
    await seedClassify(`${P}a`, 'a');
    await seedClassify(`${P}b`, 'b');
    let n = 0;
    const capping: ClassifyPredictor = () => {
      n += 1;
      return Promise.resolve(
        n >= 2 ? { status: 'cost_capped' as const } : { status: 'ok', value: { bucket: 'spam' } },
      );
    };
    const { ping, calls } = fakePing();
    const report = await runEvaluationJob(app, {
      config: makeTestConfig({
        EVALUATION_RUN_ENABLED: true,
        EVALUATION_LIVE_MODE: true,
        EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
      }),
      logger: silentLogger(),
      now: () => NOW,
      ping,
      denyTerms: [],
      predictors: { mode: 'live', classifyPredictor: capping, extractPredictor: NOOP_EXTRACT },
      syncLabels: () => Promise.resolve({ failed: 0 }),
    });
    expect(report?.status).toBe('partial');
    expect(calls).toHaveLength(0);
  });

  it('tags a stub run test_stub and never pings (non-authoritative)', async () => {
    await seedClassify(`${P}a`, 'a');
    const { ping, calls } = fakePing();
    await runEvaluationJob(app, {
      config: makeTestConfig({
        EVALUATION_RUN_ENABLED: true,
        EVALUATION_LIVE_MODE: true,
        EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
      }),
      logger: silentLogger(),
      now: () => NOW,
      ping,
      denyTerms: [],
      predictors: {
        mode: 'test_stub',
        classifyPredictor: spamClassify,
        extractPredictor: NOOP_EXTRACT,
      },
      syncLabels: () => Promise.resolve({ failed: 0 }),
    });
    const row = await owner.query<{ mode: string }>(
      `SELECT mode FROM evaluation_reports WHERE eval_set_version = $1`,
      [EVAL_SET_VERSION],
    );
    expect(row.rows[0]!.mode).toBe('test_stub');
    expect(calls).toHaveLength(0);
  });

  it('dry_run computes a report but persists nothing and never pings', async () => {
    await seedClassify(`${P}a`, 'a');
    const { ping, calls } = fakePing();
    const report = await runEvaluationJob(app, {
      config: makeTestConfig({
        EVALUATION_RUN_ENABLED: true,
        EVALUATION_LIVE_MODE: true,
        EVALUATION_CHECK_URL: 'https://checks.example.com/eval',
      }),
      logger: silentLogger(),
      now: () => NOW,
      ping,
      denyTerms: [],
      predictors: { mode: 'live', classifyPredictor: spamClassify, extractPredictor: NOOP_EXTRACT },
      syncLabels: () => Promise.resolve({ failed: 0 }),
      dryRun: true,
    });
    expect(report?.status).toBe('complete');
    expect(await reportCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
