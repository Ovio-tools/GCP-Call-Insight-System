import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { startRun } from '../../src/db/repositories/backfill-runs-repo.js';
import { findResumableRun, resetRun } from '../../src/db/repositories/backfill-runs-repo.js';
import {
  countRunCalls,
  deleteRunCalls,
  insertRunCallIfAbsent,
} from '../../src/db/repositories/backfill-run-calls-repo.js';
import { BackfillError } from '../../src/backfill/errors.js';

/**
 * DB repositories for the backfill runner (Task 11.2): the `backfill_run_calls` tracking table
 * helpers and the `backfill_runs` resume/restart helpers (`findResumableRun`, `resetRun`).
 */
describe.skipIf(!hasTestDb)('backfill repositories', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'bf-repo-call';
  const WINDOW = {
    windowStart: new Date('2021-03-01T00:00:00Z'),
    windowEnd: new Date('2021-03-02T00:00:00Z'),
  };

  async function seedCall(callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'metadata-pre-filter', 'processing') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM backfill_run_calls WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM backfill_runs WHERE window_start = $1 AND window_end = $2`, [
      WINDOW.windowStart,
      WINDOW.windowEnd,
    ]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
    await seedCall(CALL);
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('insertRunCallIfAbsent is idempotent and countRunCalls / deleteRunCalls work', async () => {
    const run = await startRun(app, { ...WINDOW, status: 'running' });
    expect(await insertRunCallIfAbsent(app, run.id, CALL)).toBe(true);
    expect(await insertRunCallIfAbsent(app, run.id, CALL)).toBe(false); // absent-only
    expect(await countRunCalls(app, run.id)).toBe(1);
    expect(await deleteRunCalls(app, run.id)).toBe(1);
    expect(await countRunCalls(app, run.id)).toBe(0);
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('findResumableRun returns a resumable run, none for completed', async () => {
    const run = await startRun(app, { ...WINDOW, status: 'interrupted' });
    const found = await findResumableRun(app, WINDOW);
    expect(found?.id).toBe(run.id);
    // Flip it to completed → no longer resumable.
    await owner.query(`UPDATE backfill_runs SET status = 'completed' WHERE id = $1`, [run.id]);
    expect(await findResumableRun(app, WINDOW)).toBeUndefined();
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('resetRun clears the checkpoint, resets status to running, and deletes tracking', async () => {
    const run = await startRun(app, {
      ...WINDOW,
      status: 'failed',
      lastCheckpoint: '{"v":1,"phase":"sweep"}',
    });
    await insertRunCallIfAbsent(app, run.id, CALL);
    const reset = await resetRun(app, run.id);
    expect(reset?.status).toBe('running');
    expect(reset?.last_checkpoint).toBeNull();
    expect(await countRunCalls(app, run.id)).toBe(0);
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('findResumableRun throws ambiguous_resumable_run when two resumable rows exist', async () => {
    // Force two resumable rows for one window by bypassing the unique index (drop it, insert, restore).
    await owner.query(`DROP INDEX IF EXISTS backfill_runs_resumable_window_uniq`);
    try {
      const a = await startRun(app, { ...WINDOW, status: 'running' });
      const b = await startRun(app, { ...WINDOW, status: 'interrupted' });
      await expect(findResumableRun(app, WINDOW)).rejects.toBeInstanceOf(BackfillError);
      await owner.query(`DELETE FROM backfill_runs WHERE id = ANY($1)`, [[a.id, b.id]]);
    } finally {
      await owner.query(
        `CREATE UNIQUE INDEX backfill_runs_resumable_window_uniq
           ON backfill_runs (window_start, window_end)
           WHERE status IN ('running','interrupted','failed')`,
      );
    }
  });
});
