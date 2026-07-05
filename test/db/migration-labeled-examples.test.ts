import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool, seedKeyVersion } from './_dal.js';

/**
 * Migration 016 — the labeled-examples corpus (Task 6.3). Reviewed decisions become a durable,
 * versioned, PII-free labeled corpus: `labeled_examples` (accepted labels + provenance),
 * `labeled_example_rejections` (content-free failed validations), and `evaluation_reports`
 * (PII-free grouped accuracy reports). This suite pins each table's shape, the CHECK constraints
 * (task_type, sources, rejection_reason, mode/status/skip_reason cross-field), the version-scoped
 * UNIQUE keys, the FKs, the append-only grants (SELECT/INSERT, never UPDATE/DELETE), and a clean
 * down.
 */
describe.skipIf(!hasTestDb)('migration 016 — labeled examples', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'mig016-call';

  async function seedActionAndReview(
    pool: Pool,
    callId: string,
  ): Promise<{ reviewId: string; actionId: string }> {
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'extract', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const rq = await pool.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'schema_invalid', now() + interval '1 hour') RETURNING id`,
      [callId],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await pool.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'mig016', 'correct_extraction', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [reviewId],
    );
    return { reviewId, actionId: oa.rows[0]!.id };
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id = $1`, [CALL]);
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

  it('creates labeled_examples with defaults and accepts a valid row', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const row = await owner.query<{ created_at: Date; source_schema_version: number | null }>(
      `INSERT INTO labeled_examples
         (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
          redacted_input, expected_output, source_prompt_version, prompt_version_source,
          source_schema_version, model_id, model_id_source, eval_set_version, pii_gate_version)
       VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'mig016', 'redacted text',
               '{"call_intent":"general"}'::jsonb, 'extract-v1', 'current_constant',
               1, NULL, 'none', 1, 1)
       RETURNING created_at, source_schema_version`,
      [actionId, reviewId, CALL],
    );
    expect(row.rows[0]!.created_at).toBeInstanceOf(Date);
    expect(row.rows[0]!.source_schema_version).toBe(1);
    await cleanup();
  });

  it('rejects an invalid task_type / prompt_version_source / model_id_source', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const insert = (taskType: string, pvSource: string, modelSource: string): Promise<unknown> =>
      owner.query(
        `INSERT INTO labeled_examples
           (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
            redacted_input, expected_output, source_prompt_version, prompt_version_source,
            model_id_source, eval_set_version, pii_gate_version)
         VALUES ($1, $4, $2, $3, 'schema_invalid', 'mig016', 'x', '{}'::jsonb, 'v', $5, $6, 1, 1)`,
        [actionId, reviewId, CALL, taskType, pvSource, modelSource],
      );
    await expect(insert('bogus', 'current_constant', 'none')).rejects.toThrow();
    await expect(insert('extract', 'bogus', 'none')).rejects.toThrow();
    await expect(insert('extract', 'current_constant', 'bogus')).rejects.toThrow();
    await cleanup();
  });

  it('enforces the version-scoped UNIQUE on labeled_examples', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const insert = (piiGate: number): Promise<unknown> =>
      owner.query(
        `INSERT INTO labeled_examples
           (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
            redacted_input, expected_output, source_prompt_version, prompt_version_source,
            model_id_source, eval_set_version, pii_gate_version)
         VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'mig016', 'x', '{}'::jsonb, 'v',
                 'current_constant', 'none', 1, $4)`,
        [actionId, reviewId, CALL, piiGate],
      );
    await insert(1);
    // Same (operator_action_id, task_type, pii_gate_version=1, eval_set_version=1) → conflict.
    await expect(insert(1)).rejects.toThrow();
    // A different pii_gate_version is a distinct version-scoped row → allowed.
    await expect(insert(2)).resolves.toBeDefined();
    await cleanup();
  });

  it('enforces the rejection_reason CHECK and the counts-nullability cross-field CHECK', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const insert = (reason: string, counts: string | null, piiGate: number): Promise<unknown> =>
      owner.query(
        `INSERT INTO labeled_example_rejections
           (operator_action_id, task_type, review_queue_id, call_id, held_reason,
            rejection_reason, rejection_counts, eval_set_version, pii_gate_version)
         VALUES ($1, 'extract', $2, $3, 'schema_invalid', $4, $5::jsonb, 1, $6)`,
        [actionId, reviewId, CALL, reason, counts, piiGate],
      );
    // pii requires non-null counts.
    await expect(insert('pii', '{"digit_run":1}', 1)).resolves.toBeDefined();
    await expect(insert('pii', null, 2)).rejects.toThrow();
    // schema / missing_clean require NULL counts.
    await expect(insert('schema', null, 3)).resolves.toBeDefined();
    await expect(insert('missing_clean', null, 4)).resolves.toBeDefined();
    await expect(insert('schema', '{"x":1}', 5)).rejects.toThrow();
    // Unknown reason.
    await expect(insert('bogus', null, 6)).rejects.toThrow();
    await cleanup();
  });

  it('enforces the evaluation_reports status × skip_reason cross-field CHECK', async () => {
    const insert = (status: string, skipReason: string, mode = 'live'): Promise<unknown> =>
      owner.query(
        `INSERT INTO evaluation_reports
           (eval_set_version, pii_gate_version, mode, status, skip_reason, generated_at,
            summary, failures, examples_evaluated, examples_skipped)
         VALUES (1, 1, $3, $1, $2, now(), '{}'::jsonb, '[]'::jsonb, 0, 0)`,
        [status, skipReason, mode],
      );
    // Valid combinations.
    await expect(insert('complete', 'none')).resolves.toBeDefined();
    await expect(insert('partial', 'cost_capped')).resolves.toBeDefined();
    await expect(insert('partial', 'killed')).resolves.toBeDefined();
    await expect(insert('skipped', 'no_examples')).resolves.toBeDefined();
    await expect(insert('test_stub', 'none', 'test_stub')).rejects.toThrow(); // bad status value
    // Invalid combinations.
    await expect(insert('complete', 'cost_capped')).rejects.toThrow();
    await expect(insert('skipped', 'none')).rejects.toThrow();
    await expect(insert('partial', 'no_examples')).rejects.toThrow();
    // dry_run is never a persisted mode.
    await expect(insert('complete', 'none', 'dry_run')).rejects.toThrow();
    await owner.query(`DELETE FROM evaluation_reports WHERE eval_set_version = 1`);
  });

  it('grants app_role SELECT/INSERT but NOT UPDATE/DELETE on all three tables', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const ins = await app.query<{ id: string }>(
      `INSERT INTO labeled_examples
         (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
          redacted_input, expected_output, source_prompt_version, prompt_version_source,
          model_id_source, eval_set_version, pii_gate_version)
       VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'mig016', 'x', '{}'::jsonb, 'v',
               'current_constant', 'none', 1, 1) RETURNING id`,
      [actionId, reviewId, CALL],
    );
    const id = ins.rows[0]!.id;
    await expect(
      app.query(`SELECT id FROM labeled_examples WHERE id = $1`, [id]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE labeled_examples SET reviewer_actor = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow();
    await expect(app.query(`DELETE FROM labeled_examples WHERE id = $1`, [id])).rejects.toThrow();
    // evaluation_reports: insert allowed, update/delete denied.
    const er = await app.query<{ id: string }>(
      `INSERT INTO evaluation_reports
         (eval_set_version, pii_gate_version, mode, status, skip_reason, generated_at,
          summary, failures, examples_evaluated, examples_skipped)
       VALUES (1, 1, 'live', 'complete', 'none', now(), '{}'::jsonb, '[]'::jsonb, 0, 0)
       RETURNING id`,
    );
    await expect(
      app.query(`UPDATE evaluation_reports SET status = 'partial' WHERE id = $1`, [er.rows[0]!.id]),
    ).rejects.toThrow();
    await owner.query(`DELETE FROM evaluation_reports WHERE eval_set_version = 1`);
    await cleanup();
  });
});
