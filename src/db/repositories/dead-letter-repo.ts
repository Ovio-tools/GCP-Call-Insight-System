import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type DeadLetterInsert,
  type DeadLetterRow,
  deadLetterInsertSchema,
  deadLetterRowSchema,
} from '../schemas/dead-letter.js';

const TABLE = 'dead_letter';

/** Record a job that exhausted retries, with sanitized root-cause metadata. Append-only. */
export async function recordDeadLetter(
  pool: Pool,
  input: DeadLetterInsert,
): Promise<DeadLetterRow> {
  const v = parseOrThrow(TABLE, deadLetterInsertSchema, input);
  const rows = await query<DeadLetterRow>(
    pool,
    `INSERT INTO dead_letter (call_id, job_payload, error_code, root_cause_category, last_error, failure_snapshot)
     VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb))
     RETURNING *`,
    [
      v.callId ?? null,
      toJsonParam(v.jobPayload),
      v.errorCode,
      v.rootCauseCategory,
      v.lastError ?? null,
      toJsonParam(v.failureSnapshot),
    ],
  );
  return parseOrThrow(TABLE, deadLetterRowSchema, rows[0]);
}

/** Whether any dead_letter row exists for this call — it exhausted retries and belongs to
 * the manual re-drive path, so automated sweeps must not silently restart it. */
export async function hasDeadLetter(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM dead_letter WHERE call_id = $1 LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

export async function listUncleared(pool: Pool): Promise<DeadLetterRow[]> {
  const rows = await query<DeadLetterRow>(pool, `SELECT * FROM dead_letter ORDER BY failed_at`);
  return rows.map((r) => parseOrThrow(TABLE, deadLetterRowSchema, r));
}

/** Count uncleared dead-letter rows — the status surface's `dead_letter_count`. Dead-letter
 * rows are append-only with no "cleared" flag yet, so every row counts (matching
 * {@link listUncleared}). A legitimate zero (no dead jobs) is distinct from a query failure
 * the caller surfaces as `unknown`. */
export async function countUncleared(pool: Pool): Promise<number> {
  const rows = await query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM dead_letter`,
  );
  return rows[0]?.count ?? 0;
}
