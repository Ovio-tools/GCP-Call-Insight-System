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

  it('fails loudly if a skipped call_state row pre-exists', async () => {
    const callId = 'test-drop-preexisting-skipped';
    // Roll migration 6 back so drop_reason and its constraints are gone.
    await migrate('down', 1);
    try {
      // A legacy 'skipped' row with no drop_reason column present.
      await pool.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1, 'test', 'metadata-pre-filter', 'skipped')`,
        [callId],
      );

      await expect(migrate('up', 1)).rejects.toThrow(/pre-existing skipped call_state rows/i);
    } finally {
      // Remediate and restore migration 6 for the rest of the suite.
      await pool.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
      await migrate('up', 1);
    }
  });
});
