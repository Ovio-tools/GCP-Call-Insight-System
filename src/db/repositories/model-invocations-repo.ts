import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type ModelInvocationRow,
  type RecordModelInvocationInput,
  modelInvocationRowSchema,
  recordModelInvocationInputSchema,
} from '../schemas/model-invocations.js';

const TABLE = 'model_invocations';

/** Record a model invocation (model ID + prompt version + token counts). Append-only —
 * one row per call per model step; idempotency is the caller's queue-job key. */
export async function recordModelInvocation(
  pool: Pool,
  input: RecordModelInvocationInput,
): Promise<ModelInvocationRow> {
  const v = parseOrThrow(TABLE, recordModelInvocationInputSchema, input);
  const rows = await query<ModelInvocationRow>(
    pool,
    `INSERT INTO model_invocations (call_id, stage, model_id, prompt_version, input_tokens, output_tokens, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [v.callId, v.stage, v.modelId, v.promptVersion, v.inputTokens, v.outputTokens, v.outcome],
  );
  return parseOrThrow(TABLE, modelInvocationRowSchema, rows[0]);
}

export async function listByCall(pool: Pool, callId: string): Promise<ModelInvocationRow[]> {
  const rows = await query<ModelInvocationRow>(
    pool,
    `SELECT * FROM model_invocations WHERE call_id = $1 ORDER BY created_at`,
    [callId],
  );
  return rows.map((r) => parseOrThrow(TABLE, modelInvocationRowSchema, r));
}

/**
 * The latest model invocation for a call at a given stage BEFORE a cutoff instant (Task 6.3
 * provenance). Used by the label-sync to attribute a mined label to the model invocation that
 * actually produced the reviewed output: classify labels look up `stage='classify'`, extract labels
 * `stage='extract'`, with `before = operator_action.created_at`. Returns `undefined` when no such
 * invocation exists — the caller then falls back to the current prompt-version constant and records
 * `model_id=NULL` / `model_id_source='none'` (never a fabricated id).
 */
export async function getLatestModelInvocationForCallStageBefore(
  pool: Pool,
  opts: { callId: string; stage: string; before: Date },
): Promise<ModelInvocationRow | undefined> {
  const rows = await query<ModelInvocationRow>(
    pool,
    `SELECT * FROM model_invocations
      WHERE call_id = $1 AND stage = $2 AND created_at < $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [opts.callId, opts.stage, opts.before],
  );
  return rows[0] ? parseOrThrow(TABLE, modelInvocationRowSchema, rows[0]) : undefined;
}
