import type { HeldReason } from '../db/enums.js';

/**
 * A fixed, plain-language explanation string per `held_reason` (Task 6.2) — what a reviewer sees
 * on the list/detail so they understand why a call was held without any transcript content. A
 * constant lookup, total over `HELD_REASON` (a `satisfies` check fails to compile if a reason is
 * missing). No PII, no free text — safe to render and to log.
 */
export const HELD_REASON_EXPLANATIONS = {
  redaction_failed:
    'Redaction could not safely remove all sensitive data, so the call was held rather than sent onward.',
  residual_pii_detected:
    'A residual-PII scan flagged possible personal data after redaction, so the call was held.',
  classifier_uncertain:
    'The classifier could not confidently decide whether this is a customer call; a person should confirm.',
  malformed_model_output:
    'A model returned output that failed validation, so the call was held rather than stored.',
  schema_invalid:
    'Extraction produced a record that failed the schema gate, so the call was held for correction.',
  emergency_review: 'This call was flagged as a possible emergency and needs prompt human review.',
  missing_transcript:
    'A transcript never became available within the wait window, so the call was held for review.',
  cost_cap_held:
    'The daily model cost cap was reached, so this call was held and can be reprocessed later.',
  weak_servicetitan_match:
    'A ServiceTitan match was too weak to trust; a person should confirm before any write-back.',
  classified_spam:
    'The classifier judged this call to be spam; a person can confirm or re-route it.',
} satisfies Record<HeldReason, string>;

/** The fixed explanation for a held_reason. */
export function explanationFor(reason: HeldReason): string {
  return HELD_REASON_EXPLANATIONS[reason];
}
