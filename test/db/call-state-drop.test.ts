import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';

const PATTERN = 'test-drop-%';

describe.skipIf(!hasTestDb)('call_state.drop_reason constraints', () => {
  let owner!: Pool;
  let app!: Pool;

  // Returns the inserted CallStateRow so tests can assert on parsed columns.
  const seedProcessing = (callId: string) =>
    upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('inserts a processing call through the DAL with drop_reason null', async () => {
    // Verifies the updated callStateRowSchema parses the new column and the app role can
    // read it back — a bad schema or missing grant fails here, right after the migration.
    const callId = 'test-drop-dal-insert';
    const row = await seedProcessing(callId);
    expect(row.status).toBe('processing');
    expect(row.drop_reason).toBeNull();
  });

  it('rejects an out-of-vocabulary drop_reason (value CHECK)', async () => {
    const callId = 'test-drop-badvalue';
    await seedProcessing(callId);
    await expect(
      owner.query(`UPDATE call_state SET status='skipped', drop_reason='bogus' WHERE call_id=$1`, [
        callId,
      ]),
    ).rejects.toThrow(/call_state_drop_reason_value_chk|violates check constraint/i);
  });

  it('rejects status=skipped with a NULL reason (biconditional CHECK)', async () => {
    const callId = 'test-drop-skipnull';
    await seedProcessing(callId);
    await expect(
      owner.query(`UPDATE call_state SET status='skipped' WHERE call_id=$1`, [callId]),
    ).rejects.toThrow(/call_state_status_drop_reason_chk|violates check constraint/i);
  });

  it('rejects a non-skipped status carrying a reason (biconditional CHECK)', async () => {
    const callId = 'test-drop-procreason';
    await seedProcessing(callId);
    await expect(
      owner.query(`UPDATE call_state SET drop_reason='zero_duration' WHERE call_id=$1`, [callId]),
    ).rejects.toThrow(/call_state_status_drop_reason_chk|violates check constraint/i);
  });

  it('accepts status=skipped with a valid reason', async () => {
    const callId = 'test-drop-ok';
    await seedProcessing(callId);
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration' WHERE call_id=$1`,
      [callId],
    );
    const res = await owner.query<{ status: string; drop_reason: string | null }>(
      `SELECT status, drop_reason FROM call_state WHERE call_id=$1`,
      [callId],
    );
    expect(res.rows[0]).toEqual({ status: 'skipped', drop_reason: 'zero_duration' });
  });
});
