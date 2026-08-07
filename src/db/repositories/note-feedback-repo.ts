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

/**
 * EVERY verdict ever recorded, oldest first — the input to the note-quality report and the note
 * fixture export (Task 6.3).
 *
 * Deliberately unfiltered and un-aggregated: the standing-verdict resolution happens in PURE code
 * (`resolveStanding`), so the rule that decides which of a reviewer's verdicts counts is unit-
 * testable without a database and is written once rather than repeated in every SQL reader. The
 * ordering matches the tie-break those readers use (`created_at`, then `id`).
 *
 * Rows are NOT scoped to a prompt version: an agreement-by-prompt-version comparison needs the old
 * version's verdicts to survive a regeneration, which is the entire point of the comparison.
 */
export async function listNoteFeedbackForEvaluation(db: Queryable): Promise<NoteFeedbackRow[]> {
  const rows = await query<NoteFeedbackRow>(
    db,
    `SELECT id, call_id, note_prompt_version, reviewer_actor, field_path, verdict,
            corrected_enum_value, created_at
       FROM note_feedback
      ORDER BY call_id, note_prompt_version, field_path, reviewer_actor, created_at, id`,
  );
  return rows.map((r) => parseOrThrow(TABLE, noteFeedbackRowSchema, r));
}

/** One reviewer's running tally at one note prompt version. */
export interface ReviewerTally {
  /** Distinct (call_id, field_path) pairs this reviewer has a standing verdict on. */
  fieldsChecked: number;
  /** How many of those standing verdicts are `correct`. */
  markedRight: number;
}

/**
 * The signed-in reviewer's own tally across every note at one prompt version — what the review
 * surface shows as "fields you've checked".
 *
 * Scoped to ONE reviewer deliberately: the number is a count of what that person chose to look at,
 * not a sample of anything, so blending reviewers would invite reading it as an accuracy rate.
 *
 * The inner `DISTINCT ON` resolves the STANDING verdict per (call_id, field_path) with the same
 * tie-break as {@link getLatestNoteFeedback}, so a reviewer who revised a verdict is counted once,
 * at its latest value — never twice, and never at the superseded value.
 */
export async function getReviewerTally(
  db: Queryable,
  opts: { reviewerActor: string; notePromptVersion: string },
): Promise<ReviewerTally> {
  const rows = await query<{ fields_checked: string; marked_right: string }>(
    db,
    `SELECT count(*)::text AS fields_checked,
            count(*) FILTER (WHERE standing.verdict = 'correct')::text AS marked_right
       FROM (
         SELECT DISTINCT ON (call_id, field_path) verdict
           FROM note_feedback
          WHERE reviewer_actor = $1 AND note_prompt_version = $2
          ORDER BY call_id, field_path, created_at DESC, id DESC
       ) standing`,
    [opts.reviewerActor, opts.notePromptVersion],
  );
  return {
    fieldsChecked: Number(rows[0]?.fields_checked ?? '0'),
    markedRight: Number(rows[0]?.marked_right ?? '0'),
  };
}
