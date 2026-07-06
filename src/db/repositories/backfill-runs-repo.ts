import { parseOrThrow } from '../errors.js';
import { query, withTransaction } from '../sql.js';
import type { Queryable } from '../types.js';
import type { Pool } from 'pg';
import { BackfillError } from '../../backfill/errors.js';
import {
  type BackfillRunInsert,
  type BackfillRunRow,
  RESUMABLE_BACKFILL_RUN_STATUSES,
  backfillRunInsertSchema,
  backfillRunRowSchema,
} from '../schemas/backfill-runs.js';
import { deleteRunCalls } from './backfill-run-calls-repo.js';

const TABLE = 'backfill_runs';

export async function startRun(pool: Pool, input: BackfillRunInsert): Promise<BackfillRunRow> {
  const v = parseOrThrow(TABLE, backfillRunInsertSchema, input);
  const rows = await query<BackfillRunRow>(
    pool,
    `INSERT INTO backfill_runs (window_start, window_end, status, last_checkpoint)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [v.windowStart, v.windowEnd, v.status, v.lastCheckpoint ?? null],
  );
  return parseOrThrow(TABLE, backfillRunRowSchema, rows[0]);
}

export async function updateCheckpoint(
  pool: Pool,
  id: string,
  update: { lastCheckpoint?: string | null; status?: string },
): Promise<BackfillRunRow | undefined> {
  const rows = await query<BackfillRunRow>(
    pool,
    `UPDATE backfill_runs
        SET last_checkpoint = COALESCE($2, last_checkpoint),
            status = COALESCE($3, status),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, update.lastCheckpoint ?? null, update.status ?? null],
  );
  return rows[0] ? parseOrThrow(TABLE, backfillRunRowSchema, rows[0]) : undefined;
}

export async function getRun(db: Queryable, id: string): Promise<BackfillRunRow | undefined> {
  const rows = await query<BackfillRunRow>(db, `SELECT * FROM backfill_runs WHERE id = $1`, [id]);
  return rows[0] ? parseOrThrow(TABLE, backfillRunRowSchema, rows[0]) : undefined;
}

/**
 * The single RESUMABLE run for an EXACT window, or undefined (Task 11.2). Resumable =
 * `running`/`interrupted`/`failed`; `completed` is excluded, so a finished window returns none and
 * may be re-run. The migration-018 UNIQUE partial index guarantees at most one such row per window;
 * this throws `BackfillError('ambiguous_resumable_run')` as defense-in-depth if that invariant is
 * ever violated (e.g. the index was dropped), rather than silently picking one.
 */
export async function findResumableRun(
  db: Queryable,
  window: { windowStart: Date; windowEnd: Date },
): Promise<BackfillRunRow | undefined> {
  const rows = await query<BackfillRunRow>(
    db,
    `SELECT * FROM backfill_runs
      WHERE window_start = $1 AND window_end = $2
        AND status = ANY($3)
      ORDER BY created_at`,
    [window.windowStart, window.windowEnd, [...RESUMABLE_BACKFILL_RUN_STATUSES]],
  );
  if (rows.length > 1) {
    throw new BackfillError(
      'ambiguous_resumable_run',
      `refusing to resume: ${rows.length} resumable runs exist for the window`,
      { count: String(rows.length) },
    );
  }
  return rows[0] ? parseOrThrow(TABLE, backfillRunRowSchema, rows[0]) : undefined;
}

/**
 * The `--restart-from-scratch` reset (Task 11.2): in ONE transaction set `status='running'`,
 * explicitly clear `last_checkpoint` to NULL (which {@link updateCheckpoint} cannot do — it
 * `COALESCE`s), and delete every `backfill_run_calls` tracking row for the run. Reuses the EXISTING
 * row (no new insert), so the UNIQUE resumable-window index never conflicts. Returns the reset row,
 * or undefined if the id is unknown.
 */
export async function resetRun(pool: Pool, id: string): Promise<BackfillRunRow | undefined> {
  return withTransaction(pool, async (client) => {
    const rows = await query<BackfillRunRow>(
      client,
      `UPDATE backfill_runs
          SET status = 'running', last_checkpoint = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id],
    );
    if (rows[0] === undefined) return undefined;
    await deleteRunCalls(client, id);
    return parseOrThrow(TABLE, backfillRunRowSchema, rows[0]);
  });
}
