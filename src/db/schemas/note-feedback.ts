import { z } from 'zod';
import {
  NOTE_CORRECTABLE_VALUES,
  noteFeedbackVerdictSchema,
  noteFieldPathSchema,
} from '../enums.js';

/**
 * note_feedback — APPEND-ONLY reviewer verdicts on individual `technician_notes` fields, so note
 * quality can be measured over time. PK: id.
 *
 * Append-only with no unique constraint: a reviewer must be able to revise a verdict, so a revision
 * is a NEW row and the latest row per (call_id, field_path, reviewer_actor, note_prompt_version)
 * wins at read time (see `getLatestNoteFeedback`).
 *
 * There is deliberately NO free-text column. `correctedEnumValue` is constrained per `fieldPath`
 * against {@link NOTE_CORRECTABLE_VALUES}; a field path absent from that map is free text and
 * admits NO correction at all — a reviewer may mark it wrong but may not retype it. Same reasoning
 * as `src/review/correction-constants.ts`: residual PII scanning is not a complete guarantee, so
 * reviewer prose never enters the system. The DB CHECK mirrors this refinement, so the rule holds
 * against a raw-SQL writer too.
 *
 * NOT PURGED and no retention columns: the table holds only field paths, verdicts, and controlled
 * enum values — nothing transcript-derived.
 */
export const noteFeedbackRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string(),
  note_prompt_version: z.string(),
  reviewer_actor: z.string(),
  field_path: noteFieldPathSchema,
  verdict: noteFeedbackVerdictSchema,
  corrected_enum_value: z.string().nullable(),
  created_at: z.date(),
});
export type NoteFeedbackRow = z.infer<typeof noteFeedbackRowSchema>;

export const recordNoteFeedbackInputSchema = z
  .object({
    callId: z.string().min(1),
    /** The prompt version of the note the verdict was given AGAINST — a verdict on v1 says
     * nothing about a v2 note, so accuracy is only ever measured within a version. */
    notePromptVersion: z.string().min(1),
    /** The authenticated subject from the session; same shape as `operator_actions.actor`. */
    reviewerActor: z.string().min(1),
    fieldPath: noteFieldPathSchema,
    verdict: noteFeedbackVerdictSchema,
    correctedEnumValue: z.string().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.correctedEnumValue === null || v.correctedEnumValue === undefined) return;
    const allowed = NOTE_CORRECTABLE_VALUES[v.fieldPath];
    if (!allowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctedEnumValue'],
        message: `field_path ${v.fieldPath} is free text and accepts no corrected value`,
      });
      return;
    }
    if (!allowed.includes(v.correctedEnumValue)) {
      // The offending value is NOT echoed — a rejected value could be PII (src/db/errors.ts).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctedEnumValue'],
        message: `corrected value is not in the controlled list for field_path ${v.fieldPath}`,
      });
    }
  });
export type RecordNoteFeedbackInput = z.infer<typeof recordNoteFeedbackInputSchema>;
