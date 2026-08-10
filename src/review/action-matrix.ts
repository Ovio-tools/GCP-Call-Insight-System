import { type HeldReason, HELD_REASON } from '../db/enums.js';
import type { PipelineStage } from '../pipeline/stages.js';

/**
 * The reason/stage-aware action model for the review surface (Task 6.2, plan §"Action model").
 *
 * `ALLOWED_ACTIONS` gates which of the seven actions a held call may take, per `held_reason`; an
 * action not in the set is a `409` (safe, no write). `REPROCESS_STAGES` lists the stages a
 * `reprocess` may target; `APPROVE_FORWARD_STAGE` is the stage `approve` re-enters from.
 * `ORIGIN_STAGES` is the set of `call_state.current_stage` values a genuine hold of that reason
 * can sit at — the handler's first-time-execution guard checks it so a completed/skipped/
 * review-closed call is never resurrected.
 *
 * All four maps are exhaustive over `HELD_REASON` via a `satisfies Record<HeldReason, …>` check,
 * so a new held_reason fails to compile until it is placed here.
 */

/** The seven review actions (distinct from the elevated `reveal_raw`, which is its own route). */
export const REVIEW_ACTIONS = [
  'approve',
  'reject',
  'mark_non_customer',
  'mark_spam',
  'correct_extraction',
  'reprocess',
  'mark_unresolvable',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Stages a `reprocess` may target, per held_reason. Empty ⇒ `reprocess` is not offered. */
export const REPROCESS_STAGES = {
  classifier_uncertain: ['classify', 'extract'],
  classified_spam: ['classify'],
  malformed_model_output: ['classify'],
  schema_invalid: ['extract'],
  redaction_failed: ['redact'],
  // Policy (plan §"Action model" ²): ALL residual_pii_detected holds — whatever their origin
  // stage — restart at redact for a clean re-redaction.
  residual_pii_detected: ['redact'],
  missing_transcript: ['fetch-transcript', 'transcript-availability'],
  cost_cap_held: ['classify', 'extract'],
  weak_servicetitan_match: [],
  emergency_review: ['verbatim-pii-scan'],
} satisfies Record<HeldReason, PipelineStage[]>;

/** The stage `approve` re-enters from, for the two reasons that offer it. Typed as a
 * `Partial<Record<…>>` so indexing by any HeldReason yields `PipelineStage | undefined`. */
export const APPROVE_FORWARD_STAGE: Partial<Record<HeldReason, PipelineStage>> = {
  // approve(classifier_uncertain) writes a reviewer `customer` classify marker, then resumes
  // extract (extract throws unless the latest classify marker is customer).
  classifier_uncertain: 'extract',
  // emergency_review is LEGACY (ADR 0010): the pipeline no longer produces this reason — an
  // emergency is now a label, not a hold. Its entries here (and in REPROCESS_STAGES /
  // ORIGIN_STAGES / HELD_REASON_EXPLANATIONS) are retained so rows held before that change stay
  // resolvable. It was held AFTER its candidate was persisted, so approve resumes at
  // verbatim-pii-scan; re-running extract would simply re-label it the same way.
  emergency_review: 'verbatim-pii-scan',
};

/**
 * The `call_state.current_stage` values a genuine hold of each reason can sit at (verified from
 * the stage handlers). The first-time-execution guard requires `current_stage` to be in this
 * set. `weak_servicetitan_match` has NO current pipeline origin stage (the ServiceTitan match
 * stage is future/out-of-scope) and offers no reprocess, so its set is empty and the stage check
 * is skipped — status='held' + drop_reason IS NULL is the guard for its terminal actions.
 */
export const ORIGIN_STAGES = {
  classifier_uncertain: ['classify'],
  classified_spam: ['classify'],
  malformed_model_output: ['classify'],
  schema_invalid: ['extract'],
  redaction_failed: ['redact'],
  residual_pii_detected: ['redact', 'extract', 'verbatim-pii-scan'],
  missing_transcript: ['fetch-transcript', 'transcript-availability'],
  cost_cap_held: ['classify', 'extract'],
  weak_servicetitan_match: [],
  emergency_review: ['extract'],
} satisfies Record<HeldReason, PipelineStage[]>;

/** Build the allowed-action set for a reason from the stage maps + the always-present terminals. */
function buildAllowedActions(reason: HeldReason): Set<ReviewAction> {
  const actions = new Set<ReviewAction>();
  // reject and mark_unresolvable apply to every held call.
  actions.add('reject');
  actions.add('mark_unresolvable');
  // reprocess iff the reason has reprocess stages.
  if (REPROCESS_STAGES[reason].length > 0) actions.add('reprocess');
  // approve iff the reason has a forward stage.
  if (APPROVE_FORWARD_STAGE[reason] !== undefined) actions.add('approve');
  // correct_extraction is scoped to schema_invalid (extract-failure, no candidate/record).
  if (reason === 'schema_invalid') actions.add('correct_extraction');
  // mark_non_customer: any reason EXCEPT weak_servicetitan_match (a matched-but-weak call is a
  // customer; re-routing it to non-customer makes no sense).
  if (reason !== 'weak_servicetitan_match') actions.add('mark_non_customer');
  // mark_spam: everything except missing_transcript (no content to judge) and
  // weak_servicetitan_match (out of scope).
  if (reason !== 'missing_transcript' && reason !== 'weak_servicetitan_match') {
    actions.add('mark_spam');
  }
  return actions;
}

export const ALLOWED_ACTIONS: Record<HeldReason, Set<ReviewAction>> = Object.fromEntries(
  HELD_REASON.map((reason) => [reason, buildAllowedActions(reason)]),
) as Record<HeldReason, Set<ReviewAction>>;

/** Whether `action` is allowed for a held call of `reason`. A disallowed action → 409 (no write). */
export function isActionAllowed(reason: HeldReason, action: ReviewAction): boolean {
  return ALLOWED_ACTIONS[reason].has(action);
}
