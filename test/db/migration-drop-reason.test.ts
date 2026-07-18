import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

describe.skipIf(!hasTestDb)('migration 6 precondition (pre-existing skipped rows)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await migrate('up'); // ensure the schema is fully migrated for later suites
    await pool.end();
  });

  // Migrations added AFTER migration 6 (drop_reason) that must be rolled back to expose it.
  // Bump this when a later migration is stacked on top: migration 7 (call_state.transcript_wait),
  // 8 (classify_reasons), 9 (extract_stage), 10 (component_heartbeats), 11 (alert_events delivery
  // cols), 12 (review_queue active-row invariants), 13 (retention purge grants, Task 8.1), 14
  // (reveal_raw enum), 15 (reprocess_requests, Task 6.2), 16 (labeled_examples, Task 6.3), 17
  // (key lifecycle, Task 8.2), 18 (backfill run status, Task 11.2), 19 (kek_versions app read
  // grant), 1782864100000 (drop raw/vault from DB-A, ADR 0008 Move 2), 1782864100001
  // (grinder_pump service_category), 1782864100002 (duplicate_call_leg drop reason), and
  // 1782864100003 (structured_knowledge.superseded_by_call_id) sit above 6, so we roll
  // back 18 migrations to reach the pre-6 schema. (The drop migration's down() recreates
  // raw_transcripts+token_vault in DB-A at the rolled-down state, but this test only touches
  // call_state, so that is harmless here.)
  const MIGRATIONS_ABOVE_6 = 18;

  it('fails loudly if a skipped call_state row pre-exists', async () => {
    const callId = 'test-drop-preexisting-skipped';
    // Roll back through the later migrations and migration 6, so drop_reason + its
    // constraints are gone while call_state itself (migration 2) still exists.
    await migrate('down', MIGRATIONS_ABOVE_6);
    try {
      // A legacy 'skipped' row with no drop_reason column present.
      await pool.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1, 'test', 'metadata-pre-filter', 'skipped')`,
        [callId],
      );

      // Re-applying stops at migration 6's precondition, which refuses to migrate.
      await expect(migrate('up', MIGRATIONS_ABOVE_6)).rejects.toThrow(
        /pre-existing skipped call_state rows/i,
      );
    } finally {
      // Remediate and restore every migration for the rest of the suite.
      await pool.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
      await migrate('up');
    }
  });
});
