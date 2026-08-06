import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type NoteFeedbackRow,
  type RecordNoteFeedbackInput,
  noteFeedbackRowSchema,
  recordNoteFeedbackInputSchema,
} from '../schemas/note-feedback.js';

const TABLE = 'note_feedback';

/**
 * Record one reviewer verdict on one note field. Append-only — every verdict is its own immutable
 * row, and a revised verdict is a NEW row rather than an update (see {@link getLatestNoteFeedback}).
 * `id` is never supplied by the app; it comes from the DB's `gen_random_uuid()` default.
 *
 * Accepts a {@link Queryable} so the verdict can enlist in the same transaction as whatever review
 * action produced it, mirroring `recordOperatorAction`.
 */
export async function recordNoteFeedback(
  db: Queryable,
  input: RecordNoteFeedbackInput,
): Promise<NoteFeedbackRow> {
  const v = parseOrThrow(TABLE, recordNoteFeedbackInputSchema, input);
  const rows = await query<NoteFeedbackRow>(
    db,
    `INSERT INTO note_feedback
       (call_id, note_prompt_version, reviewer_actor, field_path, verdict, corrected_enum_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      v.callId,
      v.notePromptVersion,
      v.reviewerActor,
      v.fieldPath,
      v.verdict,
      v.correctedEnumValue ?? null,
    ],
  );
  return parseOrThrow(TABLE, noteFeedbackRowSchema, rows[0]);
}

/** Every verdict recorded for a call, oldest first — the full audit view, revisions included. */
export async function listNoteFeedbackForCall(
  db: Queryable,
  callId: string,
): Promise<NoteFeedbackRow[]> {
  const rows = await query<NoteFeedbackRow>(
    db,
    `SELECT * FROM note_feedback WHERE call_id = $1 ORDER BY created_at, id`,
    [callId],
  );
  return rows.map((r) => parseOrThrow(TABLE, noteFeedbackRowSchema, r));
}

/**
 * The STANDING verdicts for a call at one note prompt version: the latest row per
 * (field_path, reviewer_actor). This is the read side of the append-only design — a reviewer who
 * changes their mind inserts a newer row, and only that newer row counts.
 *
 * `id DESC` breaks a `created_at` tie so two verdicts written inside the same transaction (which
 * share `now()`) still resolve deterministically to the later insert rather than an arbitrary one.
 */
export async function getLatestNoteFeedback(
  db: Queryable,
  callId: string,
  notePromptVersion: string,
): Promise<NoteFeedbackRow[]> {
  const rows = await query<NoteFeedbackRow>(
    db,
    `SELECT DISTINCT ON (field_path, reviewer_actor) *
       FROM note_feedback
      WHERE call_id = $1 AND note_prompt_version = $2
      ORDER BY field_path, reviewer_actor, created_at DESC, id DESC`,
    [callId, notePromptVersion],
  );
  return rows.map((r) => parseOrThrow(TABLE, noteFeedbackRowSchema, r));
}
