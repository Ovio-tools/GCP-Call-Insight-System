import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { DROP_REASONS } from '../../src/db/enums.js';
import { DAL_STALE_STAGE, DalError } from '../../src/db/index.js';
import { skipCall } from '../../src/db/repositories/call-state-repo.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';

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

  it('accepts status=skipped with drop_reason=classified_non_customer (Task 5.1 classify routing)', async () => {
    const callId = 'test-drop-nonCustomer';
    await seedProcessing(callId);
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='classified_non_customer' WHERE call_id=$1`,
      [callId],
    );
    const res = await owner.query<{ status: string; drop_reason: string | null }>(
      `SELECT status, drop_reason FROM call_state WHERE call_id=$1`,
      [callId],
    );
    expect(res.rows[0]).toEqual({ status: 'skipped', drop_reason: 'classified_non_customer' });
  });
});

describe.skipIf(!hasTestDb)('upsertCallState preserves terminal rows', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, 'test-reseed-%');
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('does not resurrect a skipped call on re-seed', async () => {
    const callId = 'test-reseed-skip';
    // Seed processing, then mark skipped directly (skipCall lands in Task 4; use SQL here).
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      sourceMetadata: { duration: 0 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration' WHERE call_id=$1`,
      [callId],
    );

    // A reconciliation/webhook re-seed arrives with fresh metadata + processing status.
    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      sourceMetadata: { duration: 999 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

    expect(after.status).toBe('skipped');
    expect(after.drop_reason).toBe('zero_duration');
    expect(after.current_stage).toBe('metadata-pre-filter');
    expect(after.source).toBe('dialpad'); // original source frozen
    expect(after.source_metadata).toEqual({ duration: 0 }); // original metadata frozen
  });

  it('does not resurrect a completed call on re-seed', async () => {
    const callId = 'test-reseed-done';
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      currentStage: 'mark-retention-eligible',
      status: 'completed',
    });
    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    expect(after.status).toBe('completed');
    expect(after.current_stage).toBe('mark-retention-eligible');
  });

  it('does not resurrect a held call on re-seed (fixes the latent reseed bug)', async () => {
    const callId = 'test-reseed-held';
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      sourceMetadata: { duration: 5 },
      currentStage: 'redact',
      status: 'processing',
    });
    // Mark held directly (an active review row would exist via holdCall; SQL is enough here).
    await owner.query(`UPDATE call_state SET status='held' WHERE call_id=$1`, [callId]);

    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      sourceMetadata: { duration: 999 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

    // A duplicate webhook must NOT flip a live held call back to processing and re-run it.
    expect(after.status).toBe('held');
    expect(after.current_stage).toBe('redact');
    expect(after.source).toBe('dialpad');
    expect(after.source_metadata).toEqual({ duration: 5 });
  });

  it('does not resurrect a review_closed call on re-seed', async () => {
    const callId = 'test-reseed-reviewclosed';
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      currentStage: 'redact',
      status: 'processing',
    });
    await owner.query(`UPDATE call_state SET status='review_closed' WHERE call_id=$1`, [callId]);

    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

    expect(after.status).toBe('review_closed');
    expect(after.current_stage).toBe('redact');
    expect(after.source).toBe('dialpad');
  });

  it('still overwrites a non-terminal (processing) row', async () => {
    const callId = 'test-reseed-proc';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'fetch-transcript',
      status: 'processing',
    });
    const after = await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'classify',
      status: 'processing',
    });
    expect(after.current_stage).toBe('classify');
  });
});

describe.skipIf(!hasTestDb)('skipCall', () => {
  let owner!: Pool;
  let app!: Pool;

  const seedProcessing = (callId: string): Promise<unknown> =>
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
    await cleanupCalls(owner, 'test-skip-%');
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('marks the row skipped with a reason and logs one skipped row', async () => {
    const callId = 'test-skip-basic';
    await seedProcessing(callId);

    const row = await skipCall(app, {
      callId,
      atStage: 'metadata-pre-filter',
      dropReason: 'zero_duration',
    });

    expect(row.status).toBe('skipped');
    expect(row.drop_reason).toBe('zero_duration');
    expect(row.current_stage).toBe('metadata-pre-filter'); // no forward movement

    const log = await listByCall(app, callId);
    const skipped = log.filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.stage).toBe('metadata-pre-filter');
    expect(skipped[0]?.detail).toEqual({ drop_reason: 'zero_duration' });
  });

  it('stores every DROP_REASONS value (TS/DB parity)', async () => {
    for (const reason of DROP_REASONS) {
      const callId = `test-skip-parity-${reason}`;
      await seedProcessing(callId);
      const row = await skipCall(app, {
        callId,
        atStage: 'metadata-pre-filter',
        dropReason: reason,
      });
      expect(row.drop_reason).toBe(reason);
    }
  });

  it('rejects an out-of-vocabulary reason at the DAL (zod) layer', async () => {
    const callId = 'test-skip-badreason';
    await seedProcessing(callId);
    await expect(
      // @ts-expect-error deliberately invalid reason
      skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'bogus' }),
    ).rejects.toBeInstanceOf(DalError);
  });

  it('is idempotent under a double skip (second raises DAL_STALE_STAGE, one log row)', async () => {
    const callId = 'test-skip-double';
    await seedProcessing(callId);
    await skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' });

    let code: string | undefined;
    try {
      await skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' });
    } catch (err) {
      code = err instanceof DalError ? err.code : 'other';
    }
    expect(code).toBe(DAL_STALE_STAGE);

    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
  });

  it('merges logDetail into the log row but never lets it override drop_reason', async () => {
    const callId = 'test-skip-detail';
    await seedProcessing(callId);
    await skipCall(app, {
      callId,
      atStage: 'metadata-pre-filter',
      dropReason: 'zero_duration',
      // A caller attempts to smuggle a different drop_reason plus extra detail.
      logDetail: { drop_reason: 'internal_transfer_non_operator_leg', note: 'extra' },
    });
    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.detail).toEqual({ note: 'extra', drop_reason: 'zero_duration' });
  });

  it('two concurrent skips: one wins, the other raises DAL_STALE_STAGE, one log row', async () => {
    const callId = 'test-skip-race';
    await seedProcessing(callId);
    const results = await Promise.allSettled([
      skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' }),
      skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DalError);
    expect(((rejected[0] as PromiseRejectedResult).reason as DalError).code).toBe(DAL_STALE_STAGE);
    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
  });
});
