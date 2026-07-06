import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { HeldReason } from '../db/enums.js';
import type { JsonValue } from '../db/types.js';
import { query } from '../db/sql.js';
import { recordOperatorAction } from '../db/repositories/operator-actions-repo.js';
import { syncLabeledExamples, type SyncSummary } from '../evaluation/sync.js';
import { validateRedactedInputSafe } from '../evaluation/pii-gate.js';
import { SampleValidationError } from './errors.js';

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
  heldReason: HeldReason;
  action: 'approve' | 'mark_non_customer' | 'mark_spam' | 'correct_extraction';
  actionParams?: ExtractEnums;
}

export interface MarkSampleOptions {
  /** Deny terms for the residual-PII gate applied to `notes` before storage. */
  denyTerms?: readonly string[];
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

/**
 * Record a sample mark as a review + operator-action audit row (the seed for the labeled corpus).
 *
 * The seed review row is inserted with a TERMINAL `resolved` status, NOT via `enqueueReview`: an
 * active (`open`/`in_review`) row would be escalated by the stalled-review scan (a fake
 * `REVIEW_QUEUE_STALLED` alert), occupy the one-active-per-call slot, and — via `enqueueReview`'s
 * conflict handling — risk resolving a genuine operational review for the same call. A `resolved`
 * row is invisible to the scan and outside the active partial-unique index, yet is still mined by
 * `syncLabeledExamples` (whose candidate query has no status filter).
 *
 * A `notes` value is screened by the residual-PII gate BEFORE anything is written and refused
 * (`reviewer_note_unsafe`) on a hit, so an operator cannot paste a name/phone/address into the
 * indefinite `operator_actions` audit table.
 */
export async function markSample(
  pool: Pool,
  input: MarkSampleInput,
  options: MarkSampleOptions = {},
): Promise<MarkSampleResult> {
  const mapped = mapMark(input);

  if (input.notes !== undefined) {
    const gate = validateRedactedInputSafe(input.notes, options.denyTerms ?? []);
    if (!gate.safe) {
      // Sanitized: category keys only, never the note text.
      throw new SampleValidationError(
        'reviewer_note_unsafe',
        'refusing to store a reviewer note held by the residual-PII gate',
        { categories: Object.keys(gate.counts) },
      );
    }
  }

  const slaDueAt = new Date(Date.now() + SEED_SLA_MINUTES * 60_000);
  const inserted = await query<{ id: string }>(
    pool,
    `INSERT INTO review_queue (call_id, held_reason, sla_due_at, status, resolved_at)
     VALUES ($1, $2, $3, 'resolved', now())
     RETURNING id`,
    [input.callId, mapped.heldReason, slaDueAt],
  );
  const reviewQueueId = inserted[0]!.id;

  const after: Record<string, JsonValue> = { reviewer_verdict: input.verdict };
  if (input.notes !== undefined) after.reviewer_notes = input.notes;
  if (mapped.actionParams !== undefined) {
    after.action_params = { ...mapped.actionParams };
  }

  const action = await recordOperatorAction(pool, {
    reviewQueueId,
    actor: input.actor,
    action: mapped.action,
    before: null,
    after,
  });

  return { reviewQueueId, operatorActionId: action.id };
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
