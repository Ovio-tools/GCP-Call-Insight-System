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
  // Valid task-shaped expected_output payloads (the DB CHECK enforces shape + controlled values).
  const VALID_EXTRACT =
    '{"call_intent":"general","service_category":"other","urgency":"routine","sentiment":"neutral"}';
  const VALID_CLASSIFY = '{"bucket":"spam"}';
  const PERMISSION_DENIED = '42501';

  /** Run `sql` as `role` in a rolled-back tx; returns the SQLSTATE on failure, else undefined. */
  async function runAs(role: string, sql: string): Promise<string | undefined> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql);
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

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
               $4::jsonb, 'extract-v1', 'current_constant',
               1, NULL, 'none', 1, 1)
       RETURNING created_at, source_schema_version`,
      [actionId, reviewId, CALL, VALID_EXTRACT],
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
         VALUES ($1, $4, $2, $3, 'schema_invalid', 'mig016', 'x', $7::jsonb, 'v', $5, $6, 1, 1)`,
        [actionId, reviewId, CALL, taskType, pvSource, modelSource, VALID_EXTRACT],
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
         VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'mig016', 'x', $5::jsonb, 'v',
                 'current_constant', 'none', 1, $4)`,
        [actionId, reviewId, CALL, piiGate, VALID_EXTRACT],
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

  it('enforces the expected_output shape + controlled values by task_type', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const insert = (taskType: string, payload: string, piiGate: number): Promise<unknown> =>
      owner.query(
        `INSERT INTO labeled_examples
           (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
            redacted_input, expected_output, source_prompt_version, prompt_version_source,
            model_id_source, eval_set_version, pii_gate_version)
         VALUES ($1, $4, $2, $3, 'schema_invalid', 'mig016', 'x', $5::jsonb, 'v',
                 'current_constant', 'none', 1, $6)`,
        [actionId, reviewId, CALL, taskType, payload, piiGate],
      );
    // Valid classify + extract shapes accepted.
    await expect(insert('classify', VALID_CLASSIFY, 1)).resolves.toBeDefined();
    await expect(insert('extract', VALID_EXTRACT, 2)).resolves.toBeDefined();
    // classify carrying extract enums → rejected.
    await expect(insert('classify', VALID_EXTRACT, 3)).rejects.toThrow();
    // extract carrying a bucket → rejected.
    await expect(insert('extract', VALID_CLASSIFY, 4)).rejects.toThrow();
    // extract missing a controlled field → rejected.
    await expect(
      insert(
        'extract',
        '{"call_intent":"general","service_category":"other","urgency":"routine"}',
        5,
      ),
    ).rejects.toThrow();
    // invalid controlled enum value → rejected.
    await expect(
      insert(
        'extract',
        '{"call_intent":"general","service_category":"other","urgency":"nope","sentiment":"neutral"}',
        6,
      ),
    ).rejects.toThrow();
    // classify with an out-of-vocabulary bucket → rejected.
    await expect(insert('classify', '{"bucket":"held"}', 7)).rejects.toThrow();
    // EXTRA keys beyond the exact set → rejected, so no free text can ride alongside the label.
    await expect(
      insert('classify', '{"bucket":"spam","note":"caller said x"}', 8),
    ).rejects.toThrow();
    await expect(
      insert(
        'extract',
        '{"call_intent":"general","service_category":"other","urgency":"routine","sentiment":"neutral","raw":"x"}',
        9,
      ),
    ).rejects.toThrow();
    await cleanup();
  });

  it('grants app_role SELECT/INSERT but NOT UPDATE/DELETE on all three tables', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const ins = await app.query<{ id: string }>(
      `INSERT INTO labeled_examples
         (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
          redacted_input, expected_output, source_prompt_version, prompt_version_source,
          model_id_source, eval_set_version, pii_gate_version)
       VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'mig016', 'x', $4::jsonb, 'v',
               'current_constant', 'none', 1, 1) RETURNING id`,
      [actionId, reviewId, CALL, VALID_EXTRACT],
    );
    const id = ins.rows[0]!.id;
    await expect(
      app.query(`SELECT id FROM labeled_examples WHERE id = $1`, [id]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE labeled_examples SET reviewer_actor = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow();
    await expect(app.query(`DELETE FROM labeled_examples WHERE id = $1`, [id])).rejects.toThrow();

    // labeled_example_rejections: app_role SELECT/INSERT, never UPDATE/DELETE.
    const rej = await app.query<{ id: string }>(
      `INSERT INTO labeled_example_rejections
         (operator_action_id, task_type, review_queue_id, call_id, held_reason,
          rejection_reason, rejection_counts, eval_set_version, pii_gate_version)
       VALUES ($1, 'extract', $2, $3, 'schema_invalid', 'schema', NULL, 1, 1) RETURNING id`,
      [actionId, reviewId, CALL],
    );
    const rejId = rej.rows[0]!.id;
    await expect(
      app.query(`SELECT id FROM labeled_example_rejections WHERE id = $1`, [rejId]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE labeled_example_rejections SET rejection_reason = 'pii' WHERE id = $1`, [
        rejId,
      ]),
    ).rejects.toThrow();
    await expect(
      app.query(`DELETE FROM labeled_example_rejections WHERE id = $1`, [rejId]),
    ).rejects.toThrow();

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
    await expect(
      app.query(`DELETE FROM evaluation_reports WHERE id = $1`, [er.rows[0]!.id]),
    ).rejects.toThrow();
    await owner.query(`DELETE FROM evaluation_reports WHERE eval_set_version = 1`);
    await cleanup();
  });

  it('denies restricted_role and purge_role all access to the three new tables', async () => {
    for (const role of ['restricted_role', 'purge_role']) {
      for (const table of [
        'labeled_examples',
        'labeled_example_rejections',
        'evaluation_reports',
      ]) {
        // SELECT is denied (no grant to these roles → 42501).
        expect(await runAs(role, `SELECT 1 FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
        // DELETE is denied too (only app_role has DML, and only SELECT/INSERT).
        expect(await runAs(role, `DELETE FROM ${table}`)).toBe(PERMISSION_DENIED);
      }
    }
  });
});
