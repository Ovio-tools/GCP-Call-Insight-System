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
 * `current_stage`, `status`, `service_category`, `sentiment`, `gate_type` are `text`
 * columns in the schema (their value sets are owned by later tasks), so they are NOT
 * enums here.
 */

export const SEVERITY = ['critical', 'high', 'medium', 'low'] as const;

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
] as const;

export const REVIEW_STATUS = ['open', 'in_review', 'resolved', 'unresolvable'] as const;

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
export const reviewStatusSchema = z.enum(REVIEW_STATUS);
export const operatorActionSchema = z.enum(OPERATOR_ACTION);
export const keyVersionStatusSchema = z.enum(KEY_VERSION_STATUS);
export const signatureStatusSchema = z.enum(SIGNATURE_STATUS);
export const callIntentSchema = z.enum(CALL_INTENT);
export const urgencySchema = z.enum(URGENCY);

export type Severity = z.infer<typeof severitySchema>;
export type HeldReason = z.infer<typeof heldReasonSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type OperatorActionKind = z.infer<typeof operatorActionSchema>;
export type KeyVersionStatus = z.infer<typeof keyVersionStatusSchema>;
export type SignatureStatus = z.infer<typeof signatureStatusSchema>;
export type CallIntent = z.infer<typeof callIntentSchema>;
export type Urgency = z.infer<typeof urgencySchema>;
