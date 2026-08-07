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
 *
 * `below_minimum_duration`: a call too short to hold a conversation
 * (`PREFILTER_MIN_DURATION_MS`). Kept lexically distinct from `zero_duration` because the
 * two answer different operator questions — "the call never connected" versus "the call
 * connected but nobody spoke" — and only the latter is a tunable policy.
 */
export const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
  'classified_non_customer',
  'duplicate_call_leg',
  'below_minimum_duration',
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

/**
 * `operator_actions.action` — the review-surface actions (Task 6.1/6.2).
 *
 * `reveal_raw` (Task 6.2): appended because an elevated reviewer's audited raw/vault reveal
 * must carry a controlled `operator_action` value and no existing one fits — it is a read
 * disclosure, not a state transition. Appended at the END so the value ordinal matches the
 * migration's `addTypeValue` (default end position) — the parity test compares `enum_range`
 * order exactly.
 */
export const OPERATOR_ACTION = [
  'approve',
  'reject',
  'reprocess',
  'mark_non_customer',
  'mark_spam',
  'correct_extraction',
  'mark_unresolvable',
  'reveal_raw',
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
  'grinder_pump',
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

/**
 * `reprocess_requests.status` — where a reprocess/approve/correct_extraction outbox row stands
 * (Task 6.2). A `text` column guarded by the migration-`1782864000015` CHECK constraint, NOT a
 * native pg enum (same convention as `PII_SCAN_STATUSES`). MUST stay in sync with that CHECK
 * list by hand. Do NOT add to `PG_ENUMS`.
 *
 * - `pending`   — written in the state-change tx; the enqueue has not been confirmed.
 * - `sent`      — the reprocess job was enqueued (the deterministic reprocess job id).
 * - `superseded` — the reconciliation drain found `call_state` no longer at
 *   `processing`@`target_stage` (a later operator/manual recovery moved the call), so the stale
 *   work is NOT enqueued.
 */
export const REPROCESS_REQUEST_STATUSES = ['pending', 'sent', 'superseded'] as const;
export const reprocessRequestStatusSchema = z.enum(REPROCESS_REQUEST_STATUSES);
export type ReprocessRequestStatus = z.infer<typeof reprocessRequestStatusSchema>;

/**
 * Technician-note controlled vocabularies (`technician_notes` / `note_feedback`).
 *
 * All of these are `text` columns guarded by CHECK constraints added by migration
 * `1782864100005_technician_notes_and_note_feedback`, NOT native pg enums (same convention as
 * `DROP_REASONS` / `PII_SCAN_STATUSES` above). They MUST stay in sync with those CHECK lists by
 * hand; `test/db/note-vocabulary-parity.test.ts` reads the live `pg_get_constraintdef` and fails
 * on drift. Do NOT add any of them to `PG_ENUMS`.
 */

/** `technician_notes.scope_signal` — how much of the property the job touches. */
export const NOTE_SCOPE_SIGNALS = [
  'single_fixture',
  'multiple_fixtures',
  'whole_property',
  'unknown',
] as const;

/** `technician_notes.occupancy` — who the person on the call is relative to the property. */
export const NOTE_OCCUPANCIES = ['owner', 'tenant', 'property_manager', 'unknown'] as const;

/** `note_feedback.verdict` — a reviewer's judgement of ONE note field. */
export const NOTE_FEEDBACK_VERDICTS = [
  'correct',
  'wrong',
  'missing',
  'should_not_be_here',
] as const;

/**
 * WIRE-ONLY encoding for a technician-note field the call did not establish. These two constants
 * never reach the database: `src/technician-notes/parse.ts` normalizes both back to SQL NULL
 * before a record exists, so every store, gate, and surface downstream sees exactly the nulls it
 * always saw.
 *
 * They exist because structured outputs cap a schema at 16 union-typed (nullable) parameters and
 * the note has 31 fields that can legitimately be unset — the note's whole purpose is recording
 * what a call did NOT settle. Encoding "unset" as a value rather than as `null` takes the note
 * schema to zero unions, which is both under the limit and clear of it by a wide margin.
 *
 * Shared here rather than defined twice because the wire schema (`src/anthropic/client.ts`) and
 * the parser must agree on them exactly; that is the same reason the key tuples below are shared.
 */
export const NOTE_UNSET_TEXT = '';
export const NOTE_TRISTATE = ['yes', 'no', 'unknown'] as const;

/**
 * Call intents that never put a technician in a driveway: a general enquiry and a billing matter.
 * A note for one of those is a model call spent to produce an empty gap list that then sits on the
 * review surface looking like a failure.
 *
 * This is HALF a rule. A call is excluded only when its intent is on this list AND `extract` could
 * not name a plumbing topic for it (`service_category = 'other'`) — see
 * `listNoteCandidateCallIds`. The conjunction is deliberate and fail-safe: 10 of the 42
 * general/billing calls in the first corpus DID name a real topic (a water heater, a toilet, a
 * repipe), and a call misfiled under the wrong intent must still get its note. Excluding on intent
 * alone would silently lose those; the cost of being wrong the other way is about two cents.
 */
export const NOTE_NON_DISPATCH_INTENTS = [
  'general',
  'billing',
] as const satisfies readonly CallIntent[];

/**
 * The keys of each `technician_notes` jsonb object. These drive the zod object shapes in
 * `src/db/schemas/technician-notes.ts` AND appear dotted in {@link NOTE_FIELD_PATHS};
 * `test/db/note-vocabulary-parity.test.ts` asserts the two agree, so a key added here without a
 * matching field path (or vice versa) fails loudly.
 *
 * The four boolean groups record WHETHER something is true, never the value: a nullable boolean
 * cannot carry a price, an address, or a person's name. That is deliberate — `technician_notes` is
 * a durable, never-purged store, so every column on it must be structurally incapable of holding
 * free text that residual scanning might miss (ADR 0009).
 */
export const NOTE_EQUIPMENT_KEYS = [
  'type',
  'brand',
  'model',
  'capacity',
  'approximate_age',
  'fuel_type',
] as const;
export const NOTE_SYSTEM_CONTEXT_KEYS = [
  'waste_system',
  'water_source',
  'foundation_type',
  'property_age',
] as const;
export const NOTE_WATER_STATUS_KEYS = [
  'actively_running',
  'supply_shut_off',
  'shutoff_location_known',
  'active_damage',
] as const;
export const NOTE_PAYER_AUTHORITY_KEYS = [
  'can_approve_work',
  'home_warranty',
  'insurance_claim',
  'third_party_payer',
] as const;
export const NOTE_PRIOR_WORK_KEYS = [
  'is_repeat_visit',
  'is_warranty_claim',
  'prior_work_by_others',
] as const;
export const NOTE_COMMITMENTS_MADE_KEYS = [
  'price_quoted',
  'dispatch_fee_mentioned',
  'arrival_window_given',
  'technician_named',
  'scope_described',
] as const;

/**
 * `note_feedback.field_path` — every addressable field of a technician note, dotted for the jsonb
 * sub-fields. Listed literally (not derived) so the tuple reads as the exact mirror of the CHECK
 * constraint a reviewer compares it against.
 */
export const NOTE_FIELD_PATHS = [
  'scope_signal',
  'equipment.type',
  'equipment.brand',
  'equipment.model',
  'equipment.capacity',
  'equipment.approximate_age',
  'equipment.fuel_type',
  'system_context.waste_system',
  'system_context.water_source',
  'system_context.foundation_type',
  'system_context.property_age',
  'water_status.actively_running',
  'water_status.supply_shut_off',
  'water_status.shutoff_location_known',
  'water_status.active_damage',
  'payer_authority.can_approve_work',
  'payer_authority.home_warranty',
  'payer_authority.insurance_claim',
  'payer_authority.third_party_payer',
  'prior_work.is_repeat_visit',
  'prior_work.is_warranty_claim',
  'prior_work.prior_work_by_others',
  'commitments_made.price_quoted',
  'commitments_made.dispatch_fee_mentioned',
  'commitments_made.arrival_window_given',
  'commitments_made.technician_named',
  'commitments_made.scope_described',
  'location_on_property',
  'symptom_verbatim',
  'prior_attempts_detail',
  'access_notes',
  'hazards',
  'urgency_context',
  'occupancy',
  'not_established',
  'dispatch_summary',
] as const;

export const noteScopeSignalSchema = z.enum(NOTE_SCOPE_SIGNALS);
export const noteOccupancySchema = z.enum(NOTE_OCCUPANCIES);
export const noteFeedbackVerdictSchema = z.enum(NOTE_FEEDBACK_VERDICTS);
export const noteFieldPathSchema = z.enum(NOTE_FIELD_PATHS);

export type NoteScopeSignal = z.infer<typeof noteScopeSignalSchema>;
export type NoteOccupancy = z.infer<typeof noteOccupancySchema>;
export type NoteFeedbackVerdict = z.infer<typeof noteFeedbackVerdictSchema>;
export type NoteFieldPath = z.infer<typeof noteFieldPathSchema>;

/** The boolean-valued note field paths — the ones a correction expresses as 'true'/'false'. */
export const NOTE_BOOLEAN_FIELD_PATHS = [
  'water_status.actively_running',
  'water_status.supply_shut_off',
  'water_status.shutoff_location_known',
  'water_status.active_damage',
  'payer_authority.can_approve_work',
  'payer_authority.home_warranty',
  'payer_authority.insurance_claim',
  'payer_authority.third_party_payer',
  'prior_work.is_repeat_visit',
  'prior_work.is_warranty_claim',
  'prior_work.prior_work_by_others',
  'commitments_made.price_quoted',
  'commitments_made.dispatch_fee_mentioned',
  'commitments_made.arrival_window_given',
  'commitments_made.technician_named',
  'commitments_made.scope_described',
] as const satisfies readonly NoteFieldPath[];

/** The two values a boolean-field correction may carry. Text, because `corrected_enum_value` is
 * one column serving every field path. */
export const NOTE_BOOLEAN_CORRECTED_VALUES = ['true', 'false'] as const;

/**
 * Which values `note_feedback.corrected_enum_value` may carry, per `field_path`.
 *
 * A path ABSENT from this map is free text (a brand, a symptom in the caller's words, an access
 * note) and therefore admits NO correction value at all — the reviewer may still say the field is
 * wrong, but may not retype it. That absence is the whole point: it is what keeps reviewer prose
 * out of `note_feedback`, exactly as `src/review/correction-constants.ts` keeps it out of a
 * `correct_extraction` action. The DB CHECK mirrors this map, so the rule holds even against a
 * raw-SQL writer.
 */
export const NOTE_CORRECTABLE_VALUES = {
  scope_signal: NOTE_SCOPE_SIGNALS,
  occupancy: NOTE_OCCUPANCIES,
  ...Object.fromEntries(
    NOTE_BOOLEAN_FIELD_PATHS.map((p) => [p, NOTE_BOOLEAN_CORRECTED_VALUES] as const),
  ),
} as Readonly<Partial<Record<NoteFieldPath, readonly string[]>>>;

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
