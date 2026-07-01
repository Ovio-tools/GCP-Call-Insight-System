import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type ProcessingLogInsert,
  type ProcessingLogRow,
  processingLogInsertSchema,
  processingLogRowSchema,
} from '../schemas/processing-log.js';

const TABLE = 'processing_log';

/**
 * Append a processing-log row. Accepts any {@link Queryable} so it can enlist in an open
 * transaction — `advanceStage` uses this to write the log row in the same commit as the
 * stage change. Append-only; no upsert.
 */
export async function appendLog(
  q: Queryable,
  input: ProcessingLogInsert,
): Promise<ProcessingLogRow> {
  const v = parseOrThrow(TABLE, processingLogInsertSchema, input);
  const rows = await query<ProcessingLogRow>(
    q,
    `INSERT INTO processing_log (call_id, stage, outcome, error_code, detail, failure_snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING *`,
    [
      v.callId ?? null,
      v.stage,
      v.outcome,
      v.errorCode ?? null,
      toJsonParam(v.detail),
      toJsonParam(v.failureSnapshot),
    ],
  );
  return parseOrThrow(TABLE, processingLogRowSchema, rows[0]);
}

export async function listByCall(pool: Pool, callId: string): Promise<ProcessingLogRow[]> {
  const rows = await query<ProcessingLogRow>(
    pool,
    `SELECT * FROM processing_log WHERE call_id = $1 ORDER BY created_at`,
    [callId],
  );
  return rows.map((r) => parseOrThrow(TABLE, processingLogRowSchema, r));
}
