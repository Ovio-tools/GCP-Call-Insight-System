import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { JsonValue } from '../db/types.js';
import { enqueueReview } from '../db/repositories/review-queue-repo.js';
import { recordOperatorAction } from '../db/repositories/operator-actions-repo.js';
import { syncLabeledExamples, type SyncSummary } from '../evaluation/sync.js';

/**
 * Marking a validation sample correct/wrong and seeding the Phase 6.3 labeled baseline (Task 11.1).
 *
 * The harness reuses the EXISTING review contract as the seam into the labeled corpus: a mark
 * records a `review_queue` row plus an append-only `operator_actions` audit row shaped exactly as
 * the review surface would, so the existing `syncLabeledExamples` derivation (the reconciliation-
 * cron duty) mines it into `labeled_examples` with NO duplicated label logic. The reviewer asserts
 * the ground truth — the classify bucket, or the four controlled extract enums — and that assertion
 * (not the correct/wrong verdict) is what becomes the label; the verdict + notes live on the audit
 * row only. `syncLabeledExamples` reads ONLY the controlled fields, never the reviewer notes.
 */

export type SampleVerdict = 'correct' | 'wrong';

/** The four reviewer-correctable controlled enums (the only extract fields a label pins). */
export interface ExtractEnums {
  call_intent: string;
  service_category: string;
  urgency: string;
  sentiment: string;
}

export interface MarkSampleInput {
  callId: string;
  taskType: 'classify' | 'extract';
  verdict: SampleVerdict;
  actor: string;
  /** Free-text operator note. Stored on the audit row only; NEVER enters the labeled corpus. */
  notes?: string;
  /** Required for `classify`: the reviewer's asserted ground-truth bucket. */
  classifyBucket?: 'customer' | 'non-customer' | 'spam';
  /** Required for `extract`: the reviewer's asserted controlled enums. */
  extractEnums?: ExtractEnums;
}

export interface MarkSampleResult {
  reviewQueueId: string;
  operatorActionId: string;
}

/** How far ahead to stamp the seed review's SLA — arbitrary; these rows are validation artifacts. */
const SEED_SLA_MINUTES = 120;

interface Mapped {
  heldReason: 'classifier_uncertain' | 'schema_invalid';
  action: 'approve' | 'mark_non_customer' | 'mark_spam' | 'correct_extraction';
  actionParams?: ExtractEnums;
}

/**
 * Map an asserted ground truth to the (held_reason, action, action_params) tuple that
 * `actionToLabelSpec` (Task 6.3) turns back into the intended label:
 *  - customer → approve on a `classifier_uncertain` hold; non-customer → mark_non_customer;
 *    spam → mark_spam; extract → correct_extraction on a `schema_invalid` hold.
 */
function mapMark(input: MarkSampleInput): Mapped {
  if (input.taskType === 'classify') {
    if (input.classifyBucket === undefined) {
      throw new Error('markSample: a classify mark requires an asserted classifyBucket');
    }
    switch (input.classifyBucket) {
      case 'customer':
        return { heldReason: 'classifier_uncertain', action: 'approve' };
      case 'non-customer':
        return { heldReason: 'classifier_uncertain', action: 'mark_non_customer' };
      case 'spam':
        return { heldReason: 'classifier_uncertain', action: 'mark_spam' };
    }
  }
  if (input.extractEnums === undefined) {
    throw new Error('markSample: an extract mark requires the asserted extractEnums');
  }
  return {
    heldReason: 'schema_invalid',
    action: 'correct_extraction',
    actionParams: input.extractEnums,
  };
}

/** Record a sample mark as a review + operator-action audit row (the seed for the labeled corpus). */
export async function markSample(pool: Pool, input: MarkSampleInput): Promise<MarkSampleResult> {
  const mapped = mapMark(input);

  const slaDueAt = new Date(Date.now() + SEED_SLA_MINUTES * 60_000);
  const review = await enqueueReview(pool, {
    callId: input.callId,
    heldReason: mapped.heldReason,
    slaDueAt,
  });

  const after: Record<string, JsonValue> = { reviewer_verdict: input.verdict };
  if (input.notes !== undefined) after.reviewer_notes = input.notes;
  if (mapped.actionParams !== undefined) {
    after.action_params = { ...mapped.actionParams };
  }

  const action = await recordOperatorAction(pool, {
    reviewQueueId: review.id,
    actor: input.actor,
    action: mapped.action,
    before: null,
    after,
  });

  return { reviewQueueId: review.id, operatorActionId: action.id };
}

export interface SeedBaselineDeps {
  denyTerms: readonly string[];
  logger: Logger;
}

/**
 * Seed the Phase 6.3 labeled baseline from every recorded mark, via the existing idempotent
 * `syncLabeledExamples` derivation (residual-PII + schema gated). Safe to re-run.
 */
export async function seedLabeledBaseline(
  pool: Pool,
  deps: SeedBaselineDeps,
): Promise<SyncSummary> {
  return syncLabeledExamples(pool, { denyTerms: deps.denyTerms, logger: deps.logger });
}
