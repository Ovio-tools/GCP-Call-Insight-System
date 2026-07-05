import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool, seedKeyVersion } from './_dal.js';
import {
  insertLabeledExample,
  listAcceptedExamples,
} from '../../src/db/repositories/labeled-examples-repo.js';
import { insertRejection } from '../../src/db/repositories/labeled-example-rejections-repo.js';
import { insertEvaluationReport } from '../../src/db/repositories/evaluation-reports-repo.js';
import { getLatestModelInvocationForCallStageBefore } from '../../src/db/repositories/model-invocations-repo.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../../src/evaluation/version.js';

/**
 * Repositories for the labeled-examples corpus (Task 6.3): version-scoped idempotent inserts on
 * `labeled_examples` + `labeled_example_rejections`, the current-version default read, the
 * `evaluation_reports` insert, and the model-invocation provenance lookup.
 */
describe.skipIf(!hasTestDb)('labeled-examples repositories (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'lerepo-call';

  async function seedActionAndReview(
    callId: string,
  ): Promise<{ reviewId: string; actionId: string }> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'extract', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'schema_invalid', now() + interval '1 hour') RETURNING id`,
      [callId],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await owner.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'lerepo', 'correct_extraction', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [reviewId],
    );
    return { reviewId, actionId: oa.rows[0]!.id };
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM model_invocations WHERE call_id = $1`, [CALL]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id = $1)`,
      [CALL],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('inserts an accepted example and is idempotent on the version-scoped key', async () => {
    const { reviewId, actionId } = await seedActionAndReview(CALL);
    const input = {
      operatorActionId: actionId,
      taskType: 'extract' as const,
      reviewQueueId: reviewId,
      callId: CALL,
      heldReason: 'schema_invalid' as const,
      reviewerActor: 'lerepo',
      redactedInput: 'redacted transcript body',
      expectedOutput: {
        call_intent: 'general' as const,
        service_category: 'other' as const,
        urgency: 'routine' as const,
        sentiment: 'neutral' as const,
      },
      sourcePromptVersion: 'extract-v1',
      promptVersionSource: 'current_constant' as const,
      sourceSchemaVersion: 1,
      modelId: null,
      modelIdSource: 'none' as const,
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
    };
    const first = await insertLabeledExample(app, input);
    expect(first).not.toBeUndefined();
    expect(first!.expected_output).toEqual(input.expectedOutput);
    // Re-insert with the same version-scoped key → ON CONFLICT DO NOTHING → undefined.
    const second = await insertLabeledExample(app, input);
    expect(second).toBeUndefined();
    await cleanup();
  });

  it('listAcceptedExamples defaults to the current eval-set + pii-gate version', async () => {
    const { reviewId, actionId } = await seedActionAndReview(CALL);
    const base = {
      operatorActionId: actionId,
      taskType: 'classify' as const,
      reviewQueueId: reviewId,
      callId: CALL,
      heldReason: 'schema_invalid' as const,
      reviewerActor: 'lerepo',
      redactedInput: 'text',
      expectedOutput: { bucket: 'spam' as const },
      sourcePromptVersion: 'classify-v1',
      promptVersionSource: 'current_constant' as const,
      modelId: null,
      modelIdSource: 'none' as const,
    };
    // current version row
    await insertLabeledExample(app, {
      ...base,
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
    });
    // an old-gate-version row (must be excluded by the default read)
    await insertLabeledExample(app, {
      ...base,
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION + 1,
    });
    const rows = await listAcceptedExamples(app);
    const mine = rows.filter((r) => r.call_id === CALL);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.pii_gate_version).toBe(PII_GATE_VERSION);
    await cleanup();
  });

  it('inserts a content-free rejection idempotently', async () => {
    const { reviewId, actionId } = await seedActionAndReview(CALL);
    const input = {
      operatorActionId: actionId,
      taskType: 'extract' as const,
      reviewQueueId: reviewId,
      callId: CALL,
      heldReason: 'schema_invalid' as const,
      rejectionReason: 'missing_clean' as const,
      rejectionCounts: null,
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
    };
    const first = await insertRejection(app, input);
    expect(first).not.toBeUndefined();
    const second = await insertRejection(app, input);
    expect(second).toBeUndefined();
    await cleanup();
  });

  it('inserts an evaluation report', async () => {
    const row = await insertEvaluationReport(app, {
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
      mode: 'test_stub',
      status: 'complete',
      skipReason: 'none',
      generatedAt: new Date('2026-07-05T00:00:00.000Z'),
      summary: { byTaskType: { classify: { total: 1, correct: 1 } } },
      failures: [],
      examplesEvaluated: 1,
      examplesSkipped: 0,
    });
    expect(row.mode).toBe('test_stub');
    expect(row.status).toBe('complete');
    await owner.query(`DELETE FROM evaluation_reports WHERE id = $1`, [row.id]);
  });

  it('getLatestModelInvocationForCallStageBefore picks the latest pre-cutoff invocation', async () => {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [CALL],
    );
    const insertInvocation = async (promptVersion: string, at: string): Promise<void> => {
      await owner.query(
        `INSERT INTO model_invocations (call_id, stage, model_id, prompt_version, outcome, created_at)
         VALUES ($1, 'classify', 'model-x', $2, 'success', $3)`,
        [CALL, promptVersion, at],
      );
    };
    await insertInvocation('classify-v0', '2026-07-01T00:00:00.000Z');
    await insertInvocation('classify-v1', '2026-07-02T00:00:00.000Z');
    // A later, POST-cutoff invocation that must be ignored.
    await insertInvocation('classify-v2', '2026-07-10T00:00:00.000Z');
    // A different stage that must be ignored.
    await owner.query(
      `INSERT INTO model_invocations (call_id, stage, model_id, prompt_version, outcome, created_at)
       VALUES ($1, 'extract', 'model-x', 'extract-v9', 'success', '2026-07-02T12:00:00.000Z')`,
      [CALL],
    );
    const found = await getLatestModelInvocationForCallStageBefore(app, {
      callId: CALL,
      stage: 'classify',
      before: new Date('2026-07-05T00:00:00.000Z'),
    });
    expect(found?.prompt_version).toBe('classify-v1');
    expect(found?.model_id).toBe('model-x');
    // No invocation before an early cutoff.
    const none = await getLatestModelInvocationForCallStageBefore(app, {
      callId: CALL,
      stage: 'classify',
      before: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(none).toBeUndefined();
    await cleanup();
  });
});
