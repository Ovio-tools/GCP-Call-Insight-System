import { z } from 'zod';
import {
  NOTE_CORRECTABLE_VALUES,
  noteFeedbackVerdictSchema,
  noteFieldPathSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../db/enums.js';

/**
 * The response + request shapes for the note-review surface (ADR 0009). These are the ONLY shapes
 * that leave the process, and they are the allowlist.
 *
 * Two conventions carried over from `src/knowledge/dto.ts`:
 *  - `created_at` is a pre-formatted ISO-8601 STRING, never a live `Date`, so serialization is
 *    deterministic and a serializer round-trip cannot change the value.
 *  - No field is named `text`, `content`, `body`, `message`, `transcript`, `name`, `phone`,
 *    `email`, or `token` — `assertNoContentFields` (`src/logging/redaction.ts:13-44`) throws on
 *    those key names. The transcript body is `redacted_text`, matching the `clean_transcripts`
 *    column it comes from; matching there is EXACT, not substring, so `redacted_text` is clear of
 *    the list. See `sanitize.ts` for why the transcript DTO takes a different guard.
 */

export const noteReviewStateSchema = z.enum(['unreviewed', 'has_verdicts', 'has_wrong']);
export type NoteReviewStateDto = z.infer<typeof noteReviewStateSchema>;

/** One row of the paginated list. Carries the dispatch summary's FIRST LINE only — the card shows
 * a technician's first impression, and the full summary belongs on the detail page. */
export const noteListItemSchema = z.object({
  call_id: z.string(),
  created_at: z.string(),
  service_category: serviceCategorySchema,
  urgency: urgencySchema,
  dispatch_summary_first_line: z.string().nullable(),
  not_established_count: z.number().int().nonnegative(),
  review_state: noteReviewStateSchema,
});
export type NoteListItem = z.infer<typeof noteListItemSchema>;

export const noteFiltersSchema = z.object({
  service_category: serviceCategorySchema.optional(),
  urgency: urgencySchema.optional(),
  review_state: noteReviewStateSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type NoteFilters = z.infer<typeof noteFiltersSchema>;

/**
 * The reviewer's running tally. Named for what it is: a count of the fields this reviewer CHOSE to
 * look at. It is not a sample, so it is never an accuracy rate — `render.ts` states that in words
 * next to the number, and the two are emitted by one helper so neither can be edited away alone.
 */
export const noteTallySchema = z.object({
  fields_checked: z.number().int().nonnegative(),
  marked_right: z.number().int().nonnegative(),
  note_prompt_version: z.string(),
});
export type NoteTally = z.infer<typeof noteTallySchema>;

export const noteListSchema = z.object({
  filters: noteFiltersSchema,
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  results: z.array(noteListItemSchema),
  tally: noteTallySchema,
});
export type NoteList = z.infer<typeof noteListSchema>;

/** This reviewer's STANDING verdict on one field. `corrected_enum_value` is null for the 18 free-text
 * paths, which admit no correction at all. */
export const noteVerdictSchema = z.object({
  field_path: noteFieldPathSchema,
  verdict: noteFeedbackVerdictSchema,
  corrected_enum_value: z.string().nullable(),
});
export type NoteVerdict = z.infer<typeof noteVerdictSchema>;

/**
 * One note, as the detail page judges it.
 *
 * The six jsonb groups stay nested exactly as stored so a `field_path` like
 * `water_status.supply_shut_off` addresses the DTO by the same dotted path the verdict carries —
 * one vocabulary, no translation layer to drift.
 */
export const noteDetailSchema = z.object({
  call_id: z.string(),
  created_at: z.string(),
  prompt_version: z.string(),
  service_category: serviceCategorySchema,
  urgency: urgencySchema,
  scope_signal: z.string(),
  occupancy: z.string(),
  equipment: z.record(z.string().nullable()),
  system_context: z.record(z.string().nullable()),
  water_status: z.record(z.boolean().nullable()),
  payer_authority: z.record(z.boolean().nullable()),
  prior_work: z.record(z.boolean().nullable()),
  commitments_made: z.record(z.boolean().nullable()),
  location_on_property: z.string().nullable(),
  symptom_verbatim: z.string().nullable(),
  prior_attempts_detail: z.string().nullable(),
  access_notes: z.string().nullable(),
  hazards: z.array(z.string()),
  urgency_context: z.array(z.string()),
  not_established: z.array(z.string()),
  dispatch_summary: z.string().nullable(),
  verdicts: z.array(noteVerdictSchema),
  tally: noteTallySchema,
});
export type NoteDetail = z.infer<typeof noteDetailSchema>;

/**
 * The transcript the modal shows.
 *
 * A discriminated union rather than a nullable body, because the two absent cases mean different
 * things to the person reading them and the UI explains each in its own words:
 *  - `unavailable` — no readable `clean_transcripts` row (absent, soft-deleted, or hard-deleted).
 *    Also what an unknown call id returns, so enumerating ids discloses nothing.
 *  - `withheld`    — a row exists but the residual scan hit, so the body is NOT sent at all.
 */
export const noteTranscriptSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), redacted_text: z.string() }),
  z.object({ available: z.literal(false), reason: z.enum(['unavailable', 'withheld']) }),
]);
export type NoteTranscript = z.infer<typeof noteTranscriptSchema>;

/**
 * The feedback POST body.
 *
 * `.strict()` is load-bearing twice over: it rejects a client-supplied `note_prompt_version` (the
 * server takes that from the note being viewed, so a verdict is always attributable to the version
 * it was given against) and it rejects any attempt to smuggle a free-text field onto a surface that
 * deliberately has none.
 *
 * The `superRefine` mirrors `recordNoteFeedbackInputSchema` (`src/db/schemas/note-feedback.ts`) and
 * the DB CHECK. Three nets, on purpose: this one turns an off-vocabulary value into a
 * `REQUEST_MALFORMED` before any DB work, and the other two hold even against a different writer.
 * As there, the offending value is NEVER echoed in the message — a rejected value could be PII.
 */
export const noteFeedbackRequestSchema = z
  .object({
    field_path: noteFieldPathSchema,
    verdict: noteFeedbackVerdictSchema,
    corrected_enum_value: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.corrected_enum_value === null || v.corrected_enum_value === undefined) return;
    const allowed = NOTE_CORRECTABLE_VALUES[v.field_path];
    if (!allowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['corrected_enum_value'],
        message: `field_path ${v.field_path} is free text and accepts no corrected value`,
      });
      return;
    }
    if (!allowed.includes(v.corrected_enum_value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['corrected_enum_value'],
        message: `corrected value is not in the controlled list for field_path ${v.field_path}`,
      });
    }
  });
export type NoteFeedbackRequest = z.infer<typeof noteFeedbackRequestSchema>;

/** What the POST returns: the field's new standing verdict plus the refreshed tally, so the page
 * updates the buttons and the header count without a reload. */
export const noteFeedbackResponseSchema = z.object({
  verdict: noteVerdictSchema,
  tally: noteTallySchema,
});
export type NoteFeedbackResponse = z.infer<typeof noteFeedbackResponseSchema>;
