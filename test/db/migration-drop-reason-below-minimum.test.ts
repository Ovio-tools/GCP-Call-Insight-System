import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

describe.skipIf(!hasTestDb)('drop_reason below_minimum_duration CHECK', () => {
  let owner!: Pool;
  let callId: string;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    callId = `below-min-${Date.now()}`;
    await owner.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1, 'test', '{}'::jsonb, 'metadata-pre-filter', 'processing')`,
      [callId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
    await owner.end();
  });

  it('accepts drop_reason = below_minimum_duration on a skipped row', async () => {
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='below_minimum_duration' WHERE call_id=$1`,
      [callId],
    );
    const { rows } = await owner.query<{ drop_reason: string | null }>(
      `SELECT drop_reason FROM call_state WHERE call_id=$1`,
      [callId],
    );
    expect(rows[0]?.drop_reason).toBe('below_minimum_duration');
  });

  it('still rejects a drop_reason outside the controlled vocabulary', async () => {
    await expect(
      owner.query(
        `UPDATE call_state SET status='skipped', drop_reason='not_a_real_reason' WHERE call_id=$1`,
        [callId],
      ),
    ).rejects.toThrow(/call_state_drop_reason_value_chk/i);
  });
});
