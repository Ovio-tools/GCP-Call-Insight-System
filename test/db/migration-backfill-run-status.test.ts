import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool } from './_dal.js';

/**
 * Migration 018 — backfill run status + tracking (Task 11.2). Adds the `backfill_runs.status`
 * CHECK (`running`/`completed`/`interrupted`/`failed`), the UNIQUE partial index enforcing at most
 * one resumable run per exact window, and the `backfill_run_calls (backfill_run_id, call_id)`
 * tracking table (terminal-based completion). This suite pins the CHECK, the partial-unique index,
 * the tracking table's PK + FKs + grants (SELECT/INSERT/DELETE — the restart contract deletes
 * tracking rows), and a clean down.
 *
 * With migration 019 (kek_versions app read grant) stacked on top, ABOVE = 2: down(2) rolls back
 * 019 then exposes the pre-018 schema, up(2) re-applies 018 + 019.
 */
const ABOVE = 2;

describe.skipIf(!hasTestDb)('migration 018 — backfill run status + tracking', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'mig018-call';

  async function seedCall(pool: Pool, callId: string): Promise<void> {
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'metadata-pre-filter', 'processing') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  async function startRun(pool: Pool, status = 'running'): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO backfill_runs (window_start, window_end, status)
       VALUES (now() - interval '1 day', now(), $1) RETURNING id`,
      [status],
    );
    return r.rows[0]!.id;
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM backfill_run_calls WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM backfill_runs WHERE created_at > now() - interval '2 days'
                        AND window_end <= now() AND window_start >= now() - interval '2 days'`);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
    await seedCall(owner, CALL);
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('rejects an invalid backfill_runs.status via CHECK', async () => {
    await expect(startRun(owner, 'bogus')).rejects.toThrow(/check constraint|status/i);
  });

  it('accepts running / completed / interrupted / failed', async () => {
    for (const status of ['running', 'completed', 'interrupted', 'failed']) {
      const id = await startRun(owner, status);
      await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [id]);
    }
  });

  it('the UNIQUE partial index allows at most one resumable run per window', async () => {
    // Two resumable runs for the SAME window collide.
    const a = await owner.query<{ id: string }>(
      `INSERT INTO backfill_runs (window_start, window_end, status)
       VALUES (timestamptz '2020-01-01', timestamptz '2020-01-02', 'running') RETURNING id`,
    );
    await expect(
      owner.query(
        `INSERT INTO backfill_runs (window_start, window_end, status)
         VALUES (timestamptz '2020-01-01', timestamptz '2020-01-02', 'interrupted')`,
      ),
    ).rejects.toThrow(/backfill_runs_resumable|duplicate key/i);
    // A completed run for the same window is OUTSIDE the partial index → allowed.
    await owner.query(
      `INSERT INTO backfill_runs (window_start, window_end, status)
       VALUES (timestamptz '2020-01-01', timestamptz '2020-01-02', 'completed')`,
    );
    await owner.query(`DELETE FROM backfill_runs WHERE window_start = timestamptz '2020-01-01'`);
    void a;
  });

  it('creates backfill_run_calls with a composite PK and insert-if-absent semantics', async () => {
    const runId = await startRun(owner);
    await owner.query(`INSERT INTO backfill_run_calls (backfill_run_id, call_id) VALUES ($1, $2)`, [
      runId,
      CALL,
    ]);
    // Same (run, call) again → ON CONFLICT DO NOTHING is the caller's job; the PK rejects a raw dup.
    await expect(
      owner.query(`INSERT INTO backfill_run_calls (backfill_run_id, call_id) VALUES ($1, $2)`, [
        runId,
        CALL,
      ]),
    ).rejects.toThrow(/duplicate key/i);
    await owner.query(`DELETE FROM backfill_run_calls WHERE backfill_run_id = $1`, [runId]);
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [runId]);
  });

  it('enforces FKs to backfill_runs and call_state', async () => {
    const runId = await startRun(owner);
    await expect(
      owner.query(
        `INSERT INTO backfill_run_calls (backfill_run_id, call_id) VALUES (gen_random_uuid(), $1)`,
        [CALL],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `INSERT INTO backfill_run_calls (backfill_run_id, call_id) VALUES ($1, 'no-such-call')`,
        [runId],
      ),
    ).rejects.toThrow();
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [runId]);
  });

  it('grants app_role SELECT/INSERT/DELETE on backfill_run_calls (restart deletes tracking)', async () => {
    const runId = await startRun(owner);
    await app.query(`INSERT INTO backfill_run_calls (backfill_run_id, call_id) VALUES ($1, $2)`, [
      runId,
      CALL,
    ]);
    await expect(
      app.query(`SELECT 1 FROM backfill_run_calls WHERE backfill_run_id = $1`, [runId]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`DELETE FROM backfill_run_calls WHERE backfill_run_id = $1`, [runId]),
    ).resolves.toBeDefined();
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [runId]);
  });

  it('down removes the table + index + constraint; up restores them (round-trip)', async () => {
    await migrate('down', ABOVE);
    try {
      const tables = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = 'backfill_run_calls'`,
      );
      expect(tables.rows).toHaveLength(0);
      // Below 018 the status CHECK is gone → an arbitrary status is accepted.
      await owner.query(
        `INSERT INTO backfill_runs (window_start, window_end, status)
         VALUES (now() - interval '1 day', now(), 'legacy-status')`,
      );
      await owner.query(`DELETE FROM backfill_runs WHERE status = 'legacy-status'`);
    } finally {
      await migrate('up', ABOVE);
    }
    const back = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'backfill_run_calls'`,
    );
    expect(back.rows).toHaveLength(1);
  });
});
