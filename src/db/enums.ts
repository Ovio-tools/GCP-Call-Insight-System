import { z } from 'zod';

/**
 * The native Postgres ENUM types, mirrored as `as const` value tuples + zod enums.
 *
 * Single source of truth for the DAL. These MUST stay byte-for-byte identical to the
 * `ENUMS` object in `migrations/1782864000001_extensions_and_enums.cjs` — that file is
 * CommonJS and can't be imported ergonomically into strict-ESM TS, so the arrays are
 * duplicated here and a runtime parity test (`test/db/enum-parity.test.ts`) asserts
 * they match `enum_range(...)` in a live database.
 *
 * `current_stage`, `status`, `gate_type` are `text` columns in the schema (their value
 * sets are owned by later tasks), so they are NOT enums here. `service_category` and
 * `sentiment` are also `text` columns, but their value sets are owned by THIS file
 * (Task 5.2: `SERVICE_CATEGORIES` / `SENTIMENTS` below, mirrored by CHECK constraints).
 */

export const SEVERITY = ['critical', 'high', 'medium', 'low'] as const;

/**
 * `review_queue.held_reason` — why a call was held rather than dropped or stored.
 *
 * `classified_spam` (Task 5.1): appended because the classify stage's spam outcome must
 * carry a `review_queue.held_reason` and no pre-existing value fits — spam is neither a
 * redaction failure, a model malfunction, nor a ServiceTitan-match problem. It is a
 * distinct routing outcome from the classifier itself. Appended at the END so the value
 * ordinal matches the migration's `addTypeValue` (default end position) — the parity
 * test compares `enum_range` order exactly.
 * (Task 6.1) `classified_spam` now carries a real per-reason review SLA
 * (`REVIEW_SLA_MINUTES_BY_REASON`) like every other held_reason.
 */
export const HELD_REASON = [
  'redaction_failed',
  'residual_pii_detected',
  'classifier_uncertain',
  'malformed_model_output',
  'schema_invalid',
  'emergency_review',
  'missing_transcript',
  'cost_cap_held',
  'weak_servicetitan_match',
  'classified_spam',
] as const;

/**
 * Metadata pre-filter drop reasons (Task 3.1) plus the classify-stage non-customer drop
 * reason (Task 5.1). A controlled `call_state.drop_reason` vocabulary — NOT a native pg
 * enum: the column is `text` guarded by a CHECK constraint, originally added by migration
 * 1782864000006 and extended by migration 1782864000008. This tuple MUST stay in sync
 * with that CHECK list by hand (same duplication convention as the `ENUMS` mirror above).
 * Do NOT add to `PG_ENUMS`.
 *
 * `classified_non_customer` (Task 5.1): appended because the classify stage's
 * non-customer outcome must carry a controlled `call_state.drop_reason` and no
 * pre-existing value fits — it is a classifier judgment, not a metadata pre-filter
 * signal (direction, duration, call state, related-call graph).
 */
export const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
  'classified_non_customer',
] as const;

export const REVIEW_STATUS = ['open', 'in_review', 'resolved', 'unresolvable'] as const;

/**
 * `call_state.status` vocabulary (Task 6.1). `status` is a free `text` column (no pg enum), and
 * its value set is shared by the pipeline (which owns the flow) and the DB layer (which must
 * protect terminal states from a reseeding upsert). It lives HERE — the lower module both layers
 * already import — rather than in `src/pipeline/stages.ts`, so `call-state-repo.ts` can reference
 * it without a db → pipeline layering dependency. `stages.ts` re-exports its `STATUS_*` aliases
 * from this tuple.
 *
 * - `review_closed` (Task 6.1): the terminal call-state a `markUnresolvable` transition moves a
 *   held call to, kept lexically distinct from `review_queue.status='unresolvable'` so the two
 *   vocabularies stay separate.
 */
export const CALL_STATE_STATUSES = [
  'processing',
  'completed',
  'skipped',
  'held',
  'review_closed',
] as const;
export type CallStateStatus = (typeof CALL_STATE_STATUSES)[number];

/**
 * The call-state statuses `upsertCallState` must PRESERVE — never reseed back to `processing`
 * from a duplicate ingestion. Terminal or set-aside states (`completed`/`skipped`/`held`/
 * `review_closed`) are non-reseedable: a duplicate webhook must not resurrect a live held call or
 * an archived review-closed one and re-run the pipeline while it has an active/terminal review
 * row. Reprocessing goes through an explicit review action path, never generic ingestion upsert.
 */
export const UPSERT_PROTECTED_CALL_STATE_STATUSES = [
  'completed',
  'skipped',
  'held',
  'review_closed',
] as const satisfies readonly CallStateStatus[];

export const OPERATOR_ACTION = [
  'approve',
  'reject',
  'reprocess',
  'mark_non_customer',
  'mark_spam',
  'correct_extraction',
  'mark_unresolvable',
] as const;

export const KEY_VERSION_STATUS = ['active', 'rotating', 'retired', 'destroyed'] as const;

export const SIGNATURE_STATUS = ['valid', 'invalid', 'missing'] as const;

export const CALL_INTENT = [
  'new_booking',
  'existing_job',
  'quote',
  'emergency',
  'billing',
  'general',
] as const;

export const URGENCY = ['emergency', 'urgent', 'routine'] as const;

/**
 * Extract-stage controlled vocabularies (Task 5.2). Text + CHECK vocabularies — NOT
 * native pg enums: the columns are `text` guarded by CHECK constraints that migration
 * `1782864000009_extract_stage.cjs` adds to `extraction_candidates` (and to
 * `structured_knowledge` for `service_category` / `sentiment`). These tuples MUST stay
 * in sync with those CHECK lists by hand (same duplication convention as `DROP_REASONS`
 * above). Do NOT add to `PG_ENUMS`.
 *
 * `other` is the controlled fallback so the model never emits free text: anything the
 * extractor cannot place in a named category lands there instead of inventing a value.
 */
export const SERVICE_CATEGORIES = [
  'water_heater',
  'drain_blockage',
  'leak_detection_or_repair',
  'sewer_or_septic',
  'toilet',
  'faucet_sink_or_fixture',
  'shower_or_tub',
  'gas_line',
  'sump_pump_or_drainage',
  'water_quality_or_treatment',
  'repipe_or_pipe_repair',
  'appliance_install_or_hookup',
  'inspection_or_maintenance',
  'other',
] as const;

/**
 * Sentiment is INTERNAL ONLY (ADR: sentiment internal only) — never customer-facing,
 * never exported. Mirrored by the migration-`1782864000009` CHECK constraints on
 * `extraction_candidates` and `structured_knowledge`; NOT in `PG_ENUMS`.
 */
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'frustrated'] as const;

/**
 * `extraction_candidates.pii_scan_status` — where a candidate record stands with the
 * second PII scan over its verbatim `customer_language` phrases. Mirrored by the
 * migration-`1782864000009` CHECK constraint; NOT in `PG_ENUMS`.
 */
export const PII_SCAN_STATUSES = ['pending', 'passed', 'failed'] as const;

/**
 * `extraction_candidates.pii_scan_failure_kind` — why the second PII scan failed a
 * verbatim phrase (residual PII, a redaction token echoed into the phrase, or a phrase
 * that is not verbatim from the redacted transcript). Mirrored by the
 * migration-`1782864000009` CHECK constraint; NOT in `PG_ENUMS`.
 */
export const PII_SCAN_FAILURE_KINDS = [
  'residual_pii',
  'tokened_phrase',
  'verbatim_mismatch',
] as const;

/** name -> value tuple, for the parity test to iterate. */
export const PG_ENUMS = {
  severity: SEVERITY,
  held_reason: HELD_REASON,
  review_status: REVIEW_STATUS,
  operator_action: OPERATOR_ACTION,
  key_version_status: KEY_VERSION_STATUS,
  signature_status: SIGNATURE_STATUS,
  call_intent: CALL_INTENT,
  urgency: URGENCY,
} as const;

export const severitySchema = z.enum(SEVERITY);
export const heldReasonSchema = z.enum(HELD_REASON);
export const dropReasonSchema = z.enum(DROP_REASONS);
export const reviewStatusSchema = z.enum(REVIEW_STATUS);
export const operatorActionSchema = z.enum(OPERATOR_ACTION);
export const keyVersionStatusSchema = z.enum(KEY_VERSION_STATUS);
export const signatureStatusSchema = z.enum(SIGNATURE_STATUS);
export const callIntentSchema = z.enum(CALL_INTENT);
export const urgencySchema = z.enum(URGENCY);
export const serviceCategorySchema = z.enum(SERVICE_CATEGORIES);
export const sentimentSchema = z.enum(SENTIMENTS);
export const piiScanStatusSchema = z.enum(PII_SCAN_STATUSES);
export const piiScanFailureKindSchema = z.enum(PII_SCAN_FAILURE_KINDS);

export type Severity = z.infer<typeof severitySchema>;
export type HeldReason = z.infer<typeof heldReasonSchema>;
export type DropReason = z.infer<typeof dropReasonSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type OperatorActionKind = z.infer<typeof operatorActionSchema>;
export type KeyVersionStatus = z.infer<typeof keyVersionStatusSchema>;
export type SignatureStatus = z.infer<typeof signatureStatusSchema>;
export type CallIntent = z.infer<typeof callIntentSchema>;
export type Urgency = z.infer<typeof urgencySchema>;
export type ServiceCategory = z.infer<typeof serviceCategorySchema>;
export type Sentiment = z.infer<typeof sentimentSchema>;
export type PiiScanStatus = z.infer<typeof piiScanStatusSchema>;
export type PiiScanFailureKind = z.infer<typeof piiScanFailureKindSchema>;
