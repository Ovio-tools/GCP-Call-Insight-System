import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Migration 9 (extract_stage) round-trip: down must refuse while any
 * extraction_candidates rows exist (they would be silently destroyed mid-pipeline),
 * and must roll back cleanly once the table is empty. Mirrors the migration-6
 * precondition test (migration-drop-reason.test.ts).
 */
describe.skipIf(!hasTestDb)('migration 9 down-guard (extraction_candidates rows)', () => {
  let pool!: Pool;
  const callId = 'test-mig9-guard';
  // Migrations stacked ABOVE migration 9 (extract_stage) that must be rolled back first so
  // down(1) targets migration 9 itself. Bump when a later migration is added: migration 10
  // (component_heartbeats) and 11 (alert_events delivery cols) — both Task 7.3 — plus 12
  // (review_queue active-row invariants, Task 6.1) and 13 (retention purge grants, Task 8.1)
  // sit above 9.
  const MIGRATIONS_ABOVE_9 = 4;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await migrate('up'); // ensure the schema is fully migrated for later suites
    await pool.end();
  });

  it('refuses to roll back while candidate rows exist, then rolls back clean', async () => {
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'extract', 'processing')
       ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    try {
      await pool.query(
        `INSERT INTO extraction_candidates (
           call_id, call_intent, service_category, urgency, sentiment,
           schema_version, prompt_version, model_id)
         VALUES ($1, 'new_booking', 'other', 'routine', 'neutral', 1, 'v1', 'm1')`,
        [callId],
      );

      // Roll back the migrations stacked above 9 first (both are clean, data-free), so the
      // next down(1) targets migration 9 (extract_stage) exactly.
      await migrate('down', MIGRATIONS_ABOVE_9);
      await expect(migrate('down', 1)).rejects.toThrow(/extraction_candidates rows/i);

      // Remediate (clear the staging row) and the rollback goes through.
      await pool.query(`DELETE FROM extraction_candidates WHERE call_id = $1`, [callId]);
      await migrate('down', 1);
      const gone = await pool.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'extraction_candidates'`,
      );
      expect(gone.rowCount).toBe(0);

      // And up re-creates it.
      await migrate('up');
      const back = await pool.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'extraction_candidates'`,
      );
      expect(back.rowCount).toBe(1);
    } finally {
      await migrate('up');
      await pool.query(`DELETE FROM extraction_candidates WHERE call_id = $1`, [callId]);
      await pool.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
    }
  });
});
