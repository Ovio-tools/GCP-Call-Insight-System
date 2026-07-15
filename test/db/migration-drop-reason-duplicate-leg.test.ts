import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.TEST_DATABASE_URL;
const hasTestDb = Boolean(url);

describe.skipIf(!hasTestDb)('drop_reason duplicate_call_leg CHECK', () => {
  let owner: Pool;
  let callId: string;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url });
    callId = `dup-leg-${Date.now()}`;
    await owner.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1, 'test', '{}'::jsonb, 'fetch-transcript', 'processing')`,
      [callId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
    await owner.end();
  });

  it('accepts drop_reason = duplicate_call_leg on a skipped row', async () => {
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='duplicate_call_leg' WHERE call_id=$1`,
      [callId],
    );
    const { rows } = await owner.query<{ drop_reason: string | null }>(
      `SELECT drop_reason FROM call_state WHERE call_id=$1`,
      [callId],
    );
    expect(rows[0]?.drop_reason).toBe('duplicate_call_leg');
  });
});
