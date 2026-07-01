import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type BackfillRunInsert,
  type BackfillRunRow,
  backfillRunInsertSchema,
  backfillRunRowSchema,
} from '../schemas/backfill-runs.js';

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

export async function getRun(pool: Pool, id: string): Promise<BackfillRunRow | undefined> {
  const rows = await query<BackfillRunRow>(pool, `SELECT * FROM backfill_runs WHERE id = $1`, [id]);
  return rows[0] ? parseOrThrow(TABLE, backfillRunRowSchema, rows[0]) : undefined;
}
