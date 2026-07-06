import { z } from 'zod';
import { callIntentSchema, serviceCategorySchema, urgencySchema } from '../db/enums.js';

/**
 * The knowledge-base surface DTOs (Task 10.1). These are the ONLY shapes that leave the process,
 * and they are the allowlist: `sentiment` and all model metadata (`model_id`, `schema_version`,
 * `prompt_version`) are absent by construction, so they can never egress through the view, the
 * exports, the summary, or the HTML page.
 *
 * `created_at` is a pre-formatted ISO-8601 string (the DB row's `timestamptz` mapped once at the
 * repo/serializer boundary), never a live `Date`, so serialization is deterministic.
 */

/** The allowlisted per-record fields, in the canonical column order shared by the CSV header. */
export const knowledgeRecordSchema = z.object({
  call_id: z.string(),
  created_at: z.string(),
  call_intent: callIntentSchema,
  service_category: serviceCategorySchema,
  urgency: urgencySchema,
  problem_statement: z.string().nullable(),
  symptoms: z.array(z.string()),
  customer_language: z.array(z.string()),
  concerns: z.array(z.string()),
  competitor_mentions: z.array(z.string()),
  acquisition_source: z.string().nullable(),
  location_in_home: z.string().nullable(),
  access_or_scheduling_notes: z.string().nullable(),
  prior_attempts: z.string().nullable(),
});
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

/** The echoed, validated filter set — constrained-vocabulary values only (never raw `q` unless it
 * has already passed the residual scan). */
export const knowledgeFiltersSchema = z.object({
  q: z.string().optional(),
  service_category: serviceCategorySchema.optional(),
  call_intent: callIntentSchema.optional(),
  urgency: urgencySchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type KnowledgeFilters = z.infer<typeof knowledgeFiltersSchema>;

/** Counts-only summary of the WHOLE filtered set (never one page); structurally PII-free. */
export const knowledgeSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  date_span: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  by_service_category: z.array(
    z.object({ key: z.string(), count: z.number().int().nonnegative() }),
  ),
  by_call_intent: z.array(z.object({ key: z.string(), count: z.number().int().nonnegative() })),
  by_urgency: z.array(z.object({ key: z.string(), count: z.number().int().nonnegative() })),
  // Plain-language sentence. Deliberately NOT keyed `text`/`body`/`message` — those trip the
  // shared `assertNoContentFields` structural guard the serializers apply.
  narrative: z.string(),
});
export type KnowledgeSummary = z.infer<typeof knowledgeSummarySchema>;

/** The paginated VIEW body (`/knowledge.json`). */
export const knowledgeViewSchema = z.object({
  filters: knowledgeFiltersSchema,
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  results: z.array(knowledgeRecordSchema),
  summary: knowledgeSummarySchema,
});
export type KnowledgeView = z.infer<typeof knowledgeViewSchema>;

/** The all-rows EXPORT body (`export.json`). */
export const knowledgeExportSchema = z.object({
  filters: knowledgeFiltersSchema,
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  results: z.array(knowledgeRecordSchema),
});
export type KnowledgeExport = z.infer<typeof knowledgeExportSchema>;
