import { query } from '../sql.js';
import type { Queryable } from '../types.js';

const TABLE = 'backfill_run_calls';

/**
 * Track a call under a backfill run (Task 11.2). Insert-if-absent on the composite PK, so a
 * rescued pre-existing seed OR a re-run of the same call records exactly one tracking row.
 * Returns true iff THIS call created the row (false when it already existed).
 */
export async function insertRunCallIfAbsent(
  db: Queryable,
  runId: string,
  callId: string,
): Promise<boolean> {
  const rows = await query<{ call_id: string }>(
    db,
    `INSERT INTO ${TABLE} (backfill_run_id, call_id)
     VALUES ($1, $2)
     ON CONFLICT (backfill_run_id, call_id) DO NOTHING
     RETURNING call_id`,
    [runId, callId],
  );
  return rows.length > 0;
}

/** Total calls tracked under a run (both enqueued and rescued). */
export async function countRunCalls(db: Queryable, runId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    db,
    `SELECT count(*)::int AS count FROM ${TABLE} WHERE backfill_run_id = $1`,
    [runId],
  );
  return rows[0]?.count ?? 0;
}

/** Delete every tracking row for a run — the `--restart-from-scratch` reset (see resetRun). Returns
 *  the number of rows removed. */
export async function deleteRunCalls(db: Queryable, runId: string): Promise<number> {
  const rows = await query<{ call_id: string }>(
    db,
    `DELETE FROM ${TABLE} WHERE backfill_run_id = $1 RETURNING call_id`,
    [runId],
  );
  return rows.length;
}
