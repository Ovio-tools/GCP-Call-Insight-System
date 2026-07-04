import { z } from 'zod';
import {
  callIntentSchema,
  heldReasonSchema,
  reviewStatusSchema,
  sentimentSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../db/enums.js';

/**
 * The review-surface response DTOs (Task 6.2). Deliberately narrow: safe metadata, states, and
 * timestamps only — NO transcript content, NO free text, NO PII. `redacted_content` is the ONE
 * content field and is populated only from a live `clean_transcripts` row that passed a value-
 * level residual scan; otherwise it is null with a withheld reason. The serializer re-validates
 * against these schemas and runs `assertNoContentFields` first, so nothing else can ship.
 */

export const slaStateSchema = z.enum(['ok', 'due_soon', 'breached']);

/** A row in the open-review list — safe fields only. */
export const reviewListItemSchema = z.object({
  id: z.string(),
  call_id: z.string(),
  held_reason: heldReasonSchema,
  explanation: z.string(),
  status: reviewStatusSchema,
  assignee: z.string().nullable(),
  sla_due_at: z.string().nullable(),
  sla_state: slaStateSchema,
  escalated: z.boolean(),
  raw_purged: z.boolean(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type ReviewListItem = z.infer<typeof reviewListItemSchema>;

export const reviewListSchema = z.object({
  items: z.array(reviewListItemSchema),
  generated_at: z.string(),
});
export type ReviewList = z.infer<typeof reviewListSchema>;

/** The four controlled-vocabulary enums shown when a completed extracted record exists. */
export const extractedEnumsSchema = z.object({
  call_intent: callIntentSchema,
  service_category: serviceCategorySchema,
  urgency: urgencySchema,
  sentiment: sentimentSchema,
});
export type ExtractedEnums = z.infer<typeof extractedEnumsSchema>;

/** Why `redacted_content` is withheld, when it is. */
export const withheldReasonSchema = z.enum(['no_clean_transcript', 'residual_pii']);

/** One review item's detail view. */
export const reviewDetailSchema = reviewListItemSchema.extend({
  raw_available: z.boolean(),
  redacted_content_available: z.boolean(),
  redacted_content: z.string().nullable(),
  redacted_content_withheld_reason: withheldReasonSchema.nullable(),
  /** The four enums when a completed structured record exists (rare for a held call); else null. */
  extracted: extractedEnumsSchema.nullable(),
  /** The actions this held call may take, for the UI. */
  allowed_actions: z.array(z.string()),
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;
