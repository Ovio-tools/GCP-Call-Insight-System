import { z } from 'zod';
import {
  callIntentSchema,
  piiScanFailureKindSchema,
  piiScanStatusSchema,
  sentimentSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../enums.js';
import { RESIDUAL_SCAN_CATEGORIES } from '../../redaction/residual-scan.js';

/**
 * extraction_candidates — the PURGEABLE staging row between the extract stage and the
 * Task 5.3 store (never a second durable knowledge store). PK: call_id. The extract
 * stage persists only an in-memory-validated candidate; the verbatim-pii-scan stage
 * re-verifies the persisted row via the crash-safe `pii_scan_status` marker before
 * Task 5.3 copies it to structured_knowledge.
 */
export const extractionCandidateRowSchema = z.object({
  call_id: z.string(),
  call_intent: callIntentSchema,
  service_category: serviceCategorySchema,
  problem_statement: z.string().nullable(),
  symptoms: z.array(z.string()),
  customer_language: z.array(z.string()),
  location_in_home: z.string().nullable(),
  access_or_scheduling_notes: z.string().nullable(),
  prior_attempts: z.string().nullable(),
  urgency: urgencySchema,
  concerns: z.array(z.string()),
  // Internal-only (ADR: sentiment internal only).
  sentiment: sentimentSchema,
  acquisition_source: z.string().nullable(),
  competitor_mentions: z.array(z.string()),
  pii_scan_status: piiScanStatusSchema,
  pii_scan_failure_kind: piiScanFailureKindSchema.nullable(),
  pii_scan_failed_at: z.date().nullable(),
  // Numeric-only scan metadata (see piiScanFailureSchema); permissive on read since the
  // stored shape varies by failure kind.
  pii_scan_counts: z.record(z.string(), z.number()).nullable(),
  schema_version: z.number().int(),
  prompt_version: z.string(),
  model_id: z.string(),
  created_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type ExtractionCandidateRow = z.infer<typeof extractionCandidateRowSchema>;

export const extractionCandidateInsertSchema = z.object({
  callId: z.string().min(1),
  callIntent: callIntentSchema,
  serviceCategory: serviceCategorySchema,
  problemStatement: z.string().nullable().optional(),
  symptoms: z.array(z.string()).optional(),
  customerLanguage: z.array(z.string()).optional(),
  locationInHome: z.string().nullable().optional(),
  accessOrSchedulingNotes: z.string().nullable().optional(),
  priorAttempts: z.string().nullable().optional(),
  urgency: urgencySchema,
  concerns: z.array(z.string()).optional(),
  sentiment: sentimentSchema,
  acquisitionSource: z.string().nullable().optional(),
  competitorMentions: z.array(z.string()).optional(),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
});
export type ExtractionCandidateInsert = z.infer<typeof extractionCandidateInsertSchema>;

/**
 * Residual-scan hit counts keyed by the CLOSED residual-scan category vocabulary
 * (src/redaction/residual-scan.ts). Keys outside that vocabulary are rejected, so a
 * PII-shaped key (a name, a street) can never ride into `pii_scan_counts`.
 */
export const piiScanCountsSchema = z.record(
  z.enum(RESIDUAL_SCAN_CATEGORIES),
  z.number().int().nonnegative(),
);
export type PiiScanCounts = z.infer<typeof piiScanCountsSchema>;

/**
 * Why the verbatim-pii-scan failed a candidate — validated BEFORE any SQL so the
 * persisted `pii_scan_counts` metadata is numeric-only BY CONSTRUCTION: every branch is
 * `.strict()`, every value an integer, and the only string-keyed map is closed over the
 * residual-scan categories. Neither phrase text nor PII-shaped keys can reach the column.
 *
 * - `residual_pii`: the residual scanner hit inside a verbatim phrase; `counts` per
 *   scan category.
 * - `tokened_phrase`: a phrase contained one of our own redaction tokens (e.g.
 *   `[NAME_1]`) — the extractor quoted a tokenized span, so the phrase was dropped.
 * - `verbatim_mismatch`: a phrase is not verbatim from the redacted transcript (the
 *   model reconstructed or paraphrased text it should have quoted).
 */
export const piiScanFailureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('residual_pii'), counts: piiScanCountsSchema }).strict(),
  z
    .object({ kind: z.literal('tokened_phrase'), dropped_count: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal('verbatim_mismatch'),
      mismatch_count: z.number().int().nonnegative(),
      phrase_count: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type PiiScanFailure = z.infer<typeof piiScanFailureSchema>;
