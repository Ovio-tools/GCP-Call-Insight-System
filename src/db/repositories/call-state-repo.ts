import type { Pool } from 'pg';
import { z } from 'zod';
import { DAL_STALE_STAGE, DalError, parseOrThrow } from '../errors.js';
import { query, toJsonParam, withTransaction } from '../sql.js';
import type { JsonValue } from '../types.js';
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
