import { z } from 'zod';
import {
  callIntentSchema,
  sentimentSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../db/enums.js';
import { REVIEW_ACTIONS } from './action-matrix.js';

/**
 * Strict request DTOs for the review surface (Task 6.2, plan §"Request DTOs"). Every schema is
 * `.strict()` so an unknown key is rejected (→ `REQUEST_MALFORMED`), never silently stripped.
 */

/** The `:action` path segment, parsed against the strict seven-action enum — an unknown value is
 * `REQUEST_MALFORMED` (400), never a framework NOT_FOUND. */
export const reviewActionSchema = z.enum(REVIEW_ACTIONS);
export type ReviewActionName = z.infer<typeof reviewActionSchema>;

/**
 * The stages a `reprocess` body may name: the union of `REPROCESS_STAGES` values. `approve` is NOT
 * a stage (it uses `APPROVE_FORWARD_STAGE` with an EMPTY body; `stage:'approve'` is rejected). A
 * drift test pins this list to the union of `REPROCESS_STAGES`.
 */
export const REPROCESS_STAGE_VALUES = [
  'fetch-transcript',
  'transcript-availability',
  'redact',
  'classify',
  'extract',
  'verbatim-pii-scan',
] as const;
export const reprocessStageSchema = z.enum(REPROCESS_STAGE_VALUES);

export const reprocessBodySchema = z.object({ stage: reprocessStageSchema }).strict();
export type ReprocessBody = z.infer<typeof reprocessBodySchema>;

/**
 * `correct_extraction` body — enums ONLY, no reviewer free text. `problem_statement`,
 * `customer_language`, and every other field are forced to safe constants by the handler; a body
 * carrying any of them (or any other key) is rejected here.
 */
export const correctExtractionBodySchema = z
  .object({
    call_intent: callIntentSchema,
    service_category: serviceCategorySchema,
    urgency: urgencySchema,
    sentiment: sentimentSchema,
  })
  .strict();
export type CorrectExtractionBody = z.infer<typeof correctExtractionBodySchema>;

/** Terminal actions (approve/reject/mark_non_customer/mark_spam/mark_unresolvable) take an EMPTY
 * strict body — any key is `REQUEST_MALFORMED`. */
export const emptyBodySchema = z.object({}).strict();

/** A single vault token LABEL like `[NAME_1]` — the anchored form of the redaction TOKEN_PATTERN.
 * Never the decrypted value. */
export const vaultTokenSchema = z.string().regex(/^\[[A-Z_]+_\d+\]$/);

/** `/reveal-raw?token=` query — optional single vault token, strict. */
export const revealQuerySchema = z.object({ token: vaultTokenSchema.optional() }).strict();
export type RevealQuery = z.infer<typeof revealQuerySchema>;
