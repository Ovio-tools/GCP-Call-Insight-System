import type { Pool } from 'pg';
import { z } from 'zod';
import { DAL_STALE_STAGE, DalError, parseOrThrow } from '../errors.js';
import { query, toJsonParam, withTransaction } from '../sql.js';
import { type JsonValue, jsonValueSchema } from '../types.js';
import { type DropReason, type HeldReason, dropReasonSchema, heldReasonSchema } from '../enums.js';
import {
  type CallStateInsert,
  type CallStateRow,
  callStateInsertSchema,
  callStateRowSchema,
} from '../schemas/call-state.js';
import { appendLog } from './processing-log-repo.js';

const TABLE = 'call_state';

/** Idempotent upsert keyed on call_id: re-running a job updates, never duplicates. */
export async function upsertCallState(pool: Pool, input: CallStateInsert): Promise<CallStateRow> {
  const v = parseOrThrow(TABLE, callStateInsertSchema, input);
  const rows = await query<CallStateRow>(
    pool,
    `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5)
     ON CONFLICT (call_id) DO UPDATE SET
       source = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source ELSE EXCLUDED.source END,
       source_metadata = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source_metadata ELSE EXCLUDED.source_metadata END,
       current_stage = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.current_stage ELSE EXCLUDED.current_stage END,
       status = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.status ELSE EXCLUDED.status END,
       updated_at = now()
     RETURNING *`,
    [v.callId, v.source, toJsonParam(v.sourceMetadata), v.currentStage, v.status],
  );
  return parseOrThrow(TABLE, callStateRowSchema, rows[0]);
}

/**
 * Insert a call_state row ONLY if none exists; returns whether this call created it. Unlike
 * {@link upsertCallState} it never touches an existing row, so a rescuer (the reconciliation
 * sweep re-enqueueing a seeded-but-never-queued call) cannot overwrite another writer's
 * provenance or metadata.
 */
export async function seedCallStateIfAbsent(pool: Pool, input: CallStateInsert): Promise<boolean> {
  const v = parseOrThrow(TABLE, callStateInsertSchema, input);
  const rows = await query<{ call_id: string }>(
    pool,
    `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5)
     ON CONFLICT (call_id) DO NOTHING
     RETURNING call_id`,
    [v.callId, v.source, toJsonParam(v.sourceMetadata), v.currentStage, v.status],
  );
  return rows.length > 0;
}

export async function getCallState(pool: Pool, callId: string): Promise<CallStateRow | undefined> {
  const rows = await query<CallStateRow>(pool, `SELECT * FROM call_state WHERE call_id = $1`, [
    callId,
  ]);
  return rows[0] ? parseOrThrow(TABLE, callStateRowSchema, rows[0]) : undefined;
}

export interface AdvanceStageInput {
  callId: string;
  /** Optimistic guard: only advance if the call is currently at this stage. */
  fromStage?: string;
  toStage: string;
  /** Optional status change alongside the stage; keeps the existing status if omitted. */
  status?: string;
  /** processing_log row appended in the same transaction as the stage change. */
  logEntry: {
    stage: string;
    outcome: string;
    errorCode?: string;
    detail?: JsonValue;
    failureSnapshot?: JsonValue;
  };
}

const advanceStageSchema = z.object({
  callId: z.string().min(1),
  fromStage: z.string().min(1).optional(),
  toStage: z.string().min(1),
  status: z.string().min(1).optional(),
  logEntry: z.object({
    stage: z.string().min(1),
    outcome: z.string().min(1),
    errorCode: z.string().optional(),
    detail: z.unknown().optional(),
    failureSnapshot: z.unknown().optional(),
  }),
});

/**
 * Advance `call_state.current_stage` AND append a `processing_log` row in ONE
 * transaction, so the audit trail can never diverge from the state machine: both commit
 * or neither does. With `fromStage`, the UPDATE is an optimistic guard — if the call has
 * already moved on, no row matches and the transaction rolls back with
 * {@link DAL_STALE_STAGE}.
 */
export async function advanceStage(pool: Pool, input: AdvanceStageInput): Promise<CallStateRow> {
  const v = parseOrThrow(TABLE, advanceStageSchema, input);

  return withTransaction(pool, async (client) => {
    const guarded = v.fromStage !== undefined;
    const rows = await query<CallStateRow>(
      client,
      `UPDATE call_state
         SET current_stage = $1, status = COALESCE($2, status), updated_at = now()
       WHERE call_id = $3${guarded ? ' AND current_stage = $4' : ''}
       RETURNING *`,
      guarded
        ? [v.toStage, v.status ?? null, v.callId, v.fromStage]
        : [v.toStage, v.status ?? null, v.callId],
    );

    if (rows.length === 0) {
      throw new DalError(
        DAL_STALE_STAGE,
        `${DAL_STALE_STAGE}: call_state ${v.callId} not at expected stage`,
        { table: TABLE, call_id: v.callId },
      );
    }

    await appendLog(client, {
      callId: v.callId,
      stage: v.logEntry.stage,
      outcome: v.logEntry.outcome,
      ...(v.logEntry.errorCode !== undefined ? { errorCode: v.logEntry.errorCode } : {}),
      ...(v.logEntry.detail !== undefined ? { detail: v.logEntry.detail as JsonValue } : {}),
      ...(v.logEntry.failureSnapshot !== undefined
        ? { failureSnapshot: v.logEntry.failureSnapshot as JsonValue }
        : {}),
    });

    return parseOrThrow(TABLE, callStateRowSchema, rows[0]);
  });
}

/**
 * Stamp `transcript_wait_started_at = now()` the FIRST time fetch-transcript sees a
 * not-ready transcript, and return the effective (first) wait-start. `COALESCE` keeps the
 * existing value, so repeated not-ready observations never reset the window and the call
 * is racesafe across concurrent runners. Returns null only if the call_state row is gone.
 */
export async function markTranscriptWaitStarted(pool: Pool, callId: string): Promise<Date | null> {
  const rows = await query<{ transcript_wait_started_at: Date | null }>(
    pool,
    `UPDATE call_state
       SET transcript_wait_started_at = COALESCE(transcript_wait_started_at, now()),
           updated_at = now()
     WHERE call_id = $1
     RETURNING transcript_wait_started_at`,
    [callId],
  );
  return rows[0]?.transcript_wait_started_at ?? null;
}

export interface SkipCallInput {
  callId: string;
  /** Optimistic guard: only skip a call currently at this stage. */
  atStage: string;
  dropReason: DropReason;
  /** A JSON object of PII-free extra detail merged into the processing_log row. */
  logDetail?: Record<string, JsonValue>;
}

const skipCallSchema = z.object({
  callId: z.string().min(1),
  atStage: z.string().min(1),
  dropReason: dropReasonSchema,
  // A JSON object of PII-free extra detail. Validated (not cast) so a non-JSON value is
  // rejected here rather than blowing up later in appendLog.
  logDetail: z.record(z.string(), jsonValueSchema).optional(),
});

/**
 * Mark a call `skipped` with a specific `drop_reason` AND append a `processing_log`
 * row in ONE transaction — the metadata pre-filter's drop path. `current_stage` is left
 * where it is (no forward movement); the row is never deleted.
 *
 * The `status='processing'` term in the guard makes the write idempotent under
 * concurrency: once the row is `skipped`, a second runner matches zero rows and gets
 * {@link DAL_STALE_STAGE}, so no duplicate `skipped` log row is written. A drop is not a
 * failure-model failure: no error_code, no failure_snapshot.
 */
export async function skipCall(pool: Pool, input: SkipCallInput): Promise<CallStateRow> {
  const v = parseOrThrow(TABLE, skipCallSchema, input);

  return withTransaction(pool, async (client) => {
    // 'processing'/'skipped' are the status vocabulary owned by the pipeline layer; kept as
    // SQL literals here rather than importing STATUS_* to avoid a db -> pipeline layering dep.
    const rows = await query<CallStateRow>(
      client,
      `UPDATE call_state
         SET status = 'skipped', drop_reason = $2, updated_at = now()
       WHERE call_id = $1 AND current_stage = $3 AND status = 'processing'
       RETURNING *`,
      [v.callId, v.dropReason, v.atStage],
    );

    if (rows.length === 0) {
      throw new DalError(
        DAL_STALE_STAGE,
        `${DAL_STALE_STAGE}: call_state ${v.callId} not skippable at stage ${v.atStage}`,
        { table: TABLE, call_id: v.callId },
      );
    }

    // Trusted drop_reason goes LAST so a caller's logDetail can never shadow it — the
    // processing_log audit trail must always match the drop_reason written to call_state.
    const detail: JsonValue = { ...(v.logDetail ?? {}), drop_reason: v.dropReason };

    await appendLog(client, {
      callId: v.callId,
      stage: v.atStage,
      outcome: 'skipped',
      detail,
    });

    return parseOrThrow(TABLE, callStateRowSchema, rows[0]);
  });
}

export interface HoldCallInput {
  callId: string;
  /** Optimistic guard: only hold a call currently at this stage. */
  atStage: string;
  heldReason: HeldReason;
  /** Failure-model error code recorded on the processing_log row (e.g. DIALPAD_TRANSCRIPT_MISSING). */
  errorCode?: string;
  /** A JSON object of PII-free extra detail merged into the processing_log row. */
  logDetail?: Record<string, JsonValue>;
  /** The full sanitized failure_snapshot (Task 2.2 §4 fields) persisted on the held
   *  processing_log row, so a hold stays explainable after its alert is gone (Task 7.4).
   *  Built via `failureSnapshot(failure)`; it already carries only sanitized context. */
  failureSnapshot?: JsonValue;
}

const holdCallSchema = z.object({
  callId: z.string().min(1),
  atStage: z.string().min(1),
  heldReason: heldReasonSchema,
  errorCode: z.string().min(1).optional(),
  logDetail: z.record(z.string(), jsonValueSchema).optional(),
  failureSnapshot: jsonValueSchema.optional(),
});

/**
 * Mark a call `held`, write its `review_queue` row, AND append a `processing_log` row —
 * all in ONE transaction, mirroring {@link skipCall}. This is the terminal-hold path a
 * stage takes when it sets a call aside for a person (e.g. fetch-transcript's
 * `missing_transcript`). `current_stage` is left where it is; the row is never deleted.
 *
 * The `status='processing'` term in the guard makes the write idempotent under
 * concurrency: once the row is `held`, a second runner matches zero rows and gets
 * {@link DAL_STALE_STAGE}, so no duplicate review_queue/log row is written. The SLA is
 * seeded to now()+24h here (a coarse default; the review surface, Task 6.x, owns SLA
 * policy). Unlike a drop, a hold IS a failure-model event, so `error_code` is recorded.
 */
export async function holdCall(pool: Pool, input: HoldCallInput): Promise<CallStateRow> {
  const v = parseOrThrow(TABLE, holdCallSchema, input);

  return withTransaction(pool, async (client) => {
    // 'processing'/'held' are the pipeline layer's status vocabulary; kept as SQL literals
    // here (like skipCall) to avoid a db -> pipeline layering dependency.
    const rows = await query<CallStateRow>(
      client,
      `UPDATE call_state
         SET status = 'held', updated_at = now()
       WHERE call_id = $1 AND current_stage = $2 AND status = 'processing'
       RETURNING *`,
      [v.callId, v.atStage],
    );

    if (rows.length === 0) {
      throw new DalError(
        DAL_STALE_STAGE,
        `${DAL_STALE_STAGE}: call_state ${v.callId} not holdable at stage ${v.atStage}`,
        { table: TABLE, call_id: v.callId },
      );
    }

    // Only insert a review_queue row if the call isn't already open/in_review — defensive,
    // though the status guard above already serializes holds. We hold the call_state row
    // lock via the UPDATE above, so this check is race-free within the transaction.
    const existing = await query<{ id: string }>(
      client,
      `SELECT id FROM review_queue WHERE call_id = $1 AND status IN ('open', 'in_review') LIMIT 1`,
      [v.callId],
    );
    if (existing.length === 0) {
      await query(
        client,
        `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
         VALUES ($1, $2, now() + interval '24 hours')`,
        [v.callId, v.heldReason],
      );
    }

    // Trusted held_reason goes LAST so a caller's logDetail can never shadow it — the
    // processing_log audit trail must always match the held_reason written to review_queue.
    const detail: JsonValue = { ...(v.logDetail ?? {}), held_reason: v.heldReason };

    await appendLog(client, {
      callId: v.callId,
      stage: v.atStage,
      outcome: 'held',
      ...(v.errorCode !== undefined ? { errorCode: v.errorCode } : {}),
      detail,
      ...(v.failureSnapshot !== undefined ? { failureSnapshot: v.failureSnapshot } : {}),
    });

    return parseOrThrow(TABLE, callStateRowSchema, rows[0]);
  });
}

/** One in-flight stage bucket for the status surface: how many calls sit at a stage. */
export interface StageCount {
  current_stage: string;
  count: number;
}

/**
 * Count IN-FLIGHT calls (`status='processing'`) grouped by `current_stage` — the status
 * surface's per-stage counts. Read-only aggregation over `call_state` only: no transcript,
 * no PII, no content column is touched. The caller maps each DB stage name onto its DTO node;
 * an empty result is a legitimate zero, distinct from a query failure it renders as `unknown`.
 */
export async function countByProcessingStage(pool: Pool): Promise<StageCount[]> {
  return query<StageCount>(
    pool,
    `SELECT current_stage, count(*)::int AS count
       FROM call_state
      WHERE status = 'processing'
      GROUP BY current_stage`,
  );
}

/** Total calls ever ingested into the pipeline — the `calls_ingested_total` metric (Task 7.4).
 *  `call_state` is the durable per-call spine (never purged), so its row count is the ingest
 *  total. Read-only; touches no content column. */
export async function countAllCalls(pool: Pool): Promise<number> {
  const rows = await query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count FROM call_state`,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Count calls that reached the terminal `completed` status with `updated_at` in the
 * half-open interval [from, to) — the status surface's "processed today" over today's UTC
 * day boundaries. `completed` (not `done`) is the terminal status (src/pipeline/stages.ts).
 * Read-only; touches no content columns. Zero completed calls is a legitimate `0`.
 */
export async function countCompletedBetween(
  pool: Pool,
  bounds: { from: Date; to: Date },
): Promise<number> {
  const rows = await query<{ count: number }>(
    pool,
    `SELECT count(*)::int AS count
       FROM call_state
      WHERE status = 'completed'
        AND updated_at >= $1 AND updated_at < $2`,
    [bounds.from, bounds.to],
  );
  return rows[0]?.count ?? 0;
}
