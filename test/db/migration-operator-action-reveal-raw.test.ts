import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OPERATOR_ACTION } from '../../src/db/enums.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Migration 014 appends `reveal_raw` to the `operator_action` native pg enum (Task 6.2), the
 * audit action written when an elevated reviewer reveals a raw transcript / vault value. The
 * value is APPENDED so its ordinal matches the DAL mirror in src/db/enums.ts; the enum-parity
 * test compares `enum_range` order exactly. This suite pins the new value + a clean down.
 */
describe.skipIf(!hasTestDb)('migration 014 — operator_action += reveal_raw', () => {
  let pool!: Pool;
  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('adds reveal_raw as the last operator_action value', async () => {
    const res = await pool.query<{ vals: string[] }>(
      `SELECT enum_range(NULL::operator_action)::text[] AS vals`,
    );
    const vals = res.rows[0]?.vals ?? [];
    expect(vals).toContain('reveal_raw');
    expect(vals[vals.length - 1]).toBe('reveal_raw');
  });

  it('matches the DAL mirror exactly (order included)', async () => {
    const res = await pool.query<{ vals: string[] }>(
      `SELECT enum_range(NULL::operator_action)::text[] AS vals`,
    );
    expect(res.rows[0]?.vals).toEqual([...OPERATOR_ACTION]);
  });

  it('accepts an operator_actions row with action=reveal_raw', async () => {
    await pool.query(`DELETE FROM operator_actions WHERE actor = 'migration-014-test'`);
    await pool.query(`DELETE FROM review_queue WHERE call_id = 'migration-014-test-call'`);
    await pool.query(`DELETE FROM call_state WHERE call_id = 'migration-014-test-call'`);
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ('migration-014-test-call', 'test', 'redact', 'held')`,
    );
    const rq = await pool.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ('migration-014-test-call', 'redaction_failed', now() + interval '1 hour')
       RETURNING id`,
    );
    const reviewId = rq.rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
         VALUES ($1, 'migration-014-test', 'reveal_raw', '{}'::jsonb, '{}'::jsonb)`,
        [reviewId],
      ),
    ).resolves.toBeDefined();
    await pool.query(`DELETE FROM operator_actions WHERE actor = 'migration-014-test'`);
    await pool.query(`DELETE FROM review_queue WHERE call_id = 'migration-014-test-call'`);
    await pool.query(`DELETE FROM call_state WHERE call_id = 'migration-014-test-call'`);
  });
});
