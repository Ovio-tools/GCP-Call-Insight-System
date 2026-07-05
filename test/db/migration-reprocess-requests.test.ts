import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool, seedKeyVersion } from './_dal.js';

/**
 * Migration 015 — the `reprocess_requests` durable outbox (Task 6.2). A reprocess/approve/
 * correct_extraction review action writes an outbox row in the SAME tx as the state change; the
 * reconciliation cron drains pending rows after a crash/Redis outage. This suite pins the table
 * shape, the status CHECK, the FKs, the UNIQUE(operator_action_id), the pending partial index,
 * the app_role grants (SELECT/INSERT/UPDATE, never DELETE), and a clean down.
 */
describe.skipIf(!hasTestDb)('migration 015 — reprocess_requests', () => {
  let owner!: Pool;
  let app!: Pool;

  // Distinct fixture ids so parallel suites don't collide.
  const CALL = 'mig015-call';
  const OTHER_CALL = 'mig015-other';

  async function seedActionAndReview(
    pool: Pool,
    callId: string,
  ): Promise<{
    reviewId: string;
    actionId: string;
  }> {
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const rq = await pool.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'redaction_failed', now() + interval '1 hour') RETURNING id`,
      [callId],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await pool.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'mig015', 'reprocess', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [reviewId],
    );
    return { reviewId, actionId: oa.rows[0]!.id };
  }

  async function cleanup(): Promise<void> {
    for (const c of [CALL, OTHER_CALL]) {
      await owner.query(`DELETE FROM reprocess_requests WHERE call_id = $1`, [c]);
      await owner.query(
        `DELETE FROM operator_actions WHERE review_queue_id IN
          (SELECT id FROM review_queue WHERE call_id = $1)`,
        [c],
      );
      await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [c]);
      await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [c]);
    }
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

  it('creates the table with defaults (status pending, attempt_count 0)', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    const row = await owner.query<{ status: string; attempt_count: number; created_at: Date }>(
      `INSERT INTO reprocess_requests
         (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
       VALUES ($1, $2, $3, 'redact', 'mig015')
       RETURNING status, attempt_count, created_at`,
      [actionId, CALL, reviewId],
    );
    expect(row.rows[0]!.status).toBe('pending');
    expect(row.rows[0]!.attempt_count).toBe(0);
    expect(row.rows[0]!.created_at).toBeInstanceOf(Date);
    await owner.query(`DELETE FROM reprocess_requests WHERE call_id = $1`, [CALL]);
    await cleanup();
  });

  it('rejects an invalid status via the CHECK constraint', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    await expect(
      owner.query(
        `INSERT INTO reprocess_requests
           (operator_action_id, call_id, review_queue_id, target_stage, requested_by, status)
         VALUES ($1, $2, $3, 'redact', 'mig015', 'bogus')`,
        [actionId, CALL, reviewId],
      ),
    ).rejects.toThrow();
    await cleanup();
  });

  it('accepts pending, sent, superseded', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    for (const status of ['pending', 'sent', 'superseded']) {
      await owner.query(
        `INSERT INTO reprocess_requests
           (operator_action_id, call_id, review_queue_id, target_stage, requested_by, status)
         VALUES ($1, $2, $3, 'redact', 'mig015', $4)`,
        [actionId, CALL, reviewId, status],
      );
      await owner.query(`DELETE FROM reprocess_requests WHERE call_id = $1`, [CALL]);
    }
    await cleanup();
  });

  it('enforces UNIQUE(operator_action_id)', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    await owner.query(
      `INSERT INTO reprocess_requests
         (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
       VALUES ($1, $2, $3, 'redact', 'mig015')`,
      [actionId, CALL, reviewId],
    );
    await expect(
      owner.query(
        `INSERT INTO reprocess_requests
           (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
         VALUES ($1, $2, $3, 'classify', 'mig015')`,
        [actionId, CALL, reviewId],
      ),
    ).rejects.toThrow();
    await cleanup();
  });

  it('enforces FKs to operator_actions / call_state / review_queue', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    // Bad operator_action_id.
    await expect(
      owner.query(
        `INSERT INTO reprocess_requests
           (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
         VALUES (gen_random_uuid(), $1, $2, 'redact', 'mig015')`,
        [CALL, reviewId],
      ),
    ).rejects.toThrow();
    // Bad call_id.
    await expect(
      owner.query(
        `INSERT INTO reprocess_requests
           (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
         VALUES ($1, 'no-such-call', $2, 'redact', 'mig015')`,
        [actionId, reviewId],
      ),
    ).rejects.toThrow();
    await cleanup();
  });

  it('grants app_role SELECT/INSERT/UPDATE but NOT DELETE', async () => {
    const { reviewId, actionId } = await seedActionAndReview(owner, CALL);
    // INSERT via app_role.
    const ins = await app.query<{ id: string }>(
      `INSERT INTO reprocess_requests
         (operator_action_id, call_id, review_queue_id, target_stage, requested_by)
       VALUES ($1, $2, $3, 'redact', 'mig015') RETURNING id`,
      [actionId, CALL, reviewId],
    );
    const id = ins.rows[0]!.id;
    // SELECT + UPDATE via app_role.
    await expect(
      app.query(`SELECT id FROM reprocess_requests WHERE id = $1`, [id]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE reprocess_requests SET status = 'sent', sent_at = now() WHERE id = $1`, [
        id,
      ]),
    ).resolves.toBeDefined();
    // DELETE denied.
    await expect(app.query(`DELETE FROM reprocess_requests WHERE id = $1`, [id])).rejects.toThrow();
    await owner.query(`DELETE FROM reprocess_requests WHERE call_id = $1`, [CALL]);
    await cleanup();
  });

  it('has a partial index on status=pending', async () => {
    const res = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'reprocess_requests'`,
    );
    const defs = res.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/status = 'pending'/);
  });
});
