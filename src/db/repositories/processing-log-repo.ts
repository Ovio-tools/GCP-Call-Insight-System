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

/**
 * Classify outcomes grouped by the `detail.bucket` the classifier assigned — the
 * `calls_classified_total` metric (Task 7.4). CRUCIAL: the classify handler routes each bucket
 * to a DIFFERENT outcome — `customer` → `completed`, `non-customer` → `skipped`, `spam`/`held`
 * → `held` — but writes `detail.bucket` on ALL of them, so counting only `completed` rows would
 * silently under-count everything except `customer`. We therefore count every terminal classify
 * outcome (`completed`/`skipped`/`held`) that carries a bucket. Malformed / cost-cap holds have
 * no `detail.bucket` (the model produced no valid class) and are excluded — they are not a
 * classification into a bucket. `bucket` is a closed 4-value vocabulary, so the label stays
 * low-cardinality; the caller collapses any unexpected value to `unknown` as defence-in-depth.
 */
export interface StageBucketCount {
  bucket: string;
  count: number;
}
export async function countClassifyByBucket(pool: Pool): Promise<StageBucketCount[]> {
  return query<StageBucketCount>(
    pool,
    `SELECT detail->>'bucket' AS bucket, count(*)::int AS count
       FROM processing_log
      WHERE stage = 'classify'
        AND outcome IN ('completed', 'skipped', 'held')
        AND detail ? 'bucket'
      GROUP BY 1
      ORDER BY 1`,
  );
}

/** Count processing_log rows for a given stage + outcome — e.g. `extract`/`completed` (Task 7.4). */
export async function countByStageOutcome(
  pool: Pool,
  stage: string,
  outcome: string,
): Promise<number> {
  const rows = await query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM processing_log WHERE stage = $1 AND outcome = $2`,
    [stage, outcome],
  );
  return rows[0]?.count ?? 0;
}
