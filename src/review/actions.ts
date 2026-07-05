import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { JsonValue } from '../db/types.js';
import { query, withTransaction } from '../db/sql.js';
import { httpFailure } from '../http/failures.js';
import { listByReview, recordOperatorAction } from '../db/repositories/operator-actions-repo.js';
import { markUnresolvableByReviewId } from '../db/repositories/review-queue-repo.js';
import { upsertExtractionCandidate } from '../db/repositories/extraction-candidates-repo.js';
import { insertReprocessRequest } from '../db/repositories/reprocess-requests-repo.js';
import { enqueueReprocess, type ReprocessQueue } from '../queue/pipeline-queue.js';
import { EXTRACT_SCHEMA_VERSION } from '../pipeline/extract/prompt.js';
import type { PipelineStage } from '../pipeline/stages.js';
import type { HeldReason } from '../db/enums.js';
import {
  APPROVE_FORWARD_STAGE,
  ORIGIN_STAGES,
  REPROCESS_STAGES,
  type ReviewAction,
  isActionAllowed,
} from './action-matrix.js';
import { rawRetentionWindowOpen, rawTranscriptRevealAllowed } from './raw-access.js';
import { recordReviewerClassification } from './reviewer-classification.js';
import {
  HUMAN_REVIEW_MODEL_ID,
  HUMAN_REVIEW_PROBLEM_STATEMENT,
  HUMAN_REVIEW_PROMPT_VERSION,
} from './correction-constants.js';
import type { CorrectExtractionBody } from './request-dto.js';
import { ReviewConflictError, ReviewNotFoundError } from './errors.js';

/** The parsed, action-specific request body handed to {@link performReviewAction}. */
export type ReviewActionBody =
  | { kind: 'reprocess'; stage: PipelineStage }
  | { kind: 'correct_extraction'; enums: CorrectExtractionBody }
  | { kind: 'empty' };

export interface PerformReviewActionInput {
  pool: Pool;
  queue: ReprocessQueue;
  config: Config;
  now: Date;
  logger: Logger;
  reviewId: string;
  action: ReviewAction;
  body: ReviewActionBody;
  actor: string;
}

export type ReviewActionResult = { outcome: 'ok' | 'noop'; action: ReviewAction };

/** Stable, order-independent JSON for comparing audit fingerprints. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k] as JsonValue)}`).join(',')}}`;
}

interface LockedReview {
  id: string;
  status: string;
  call_id: string;
  held_reason: HeldReason;
}
interface LockedCallState {
  status: string;
  current_stage: string;
  drop_reason: string | null;
}

/** The sanitized `action_params` fingerprint an action produces — flat, PII-free. */
function fingerprintFor(
  action: ReviewAction,
  reason: HeldReason,
  body: ReviewActionBody,
): Record<string, JsonValue> {
  switch (action) {
    case 'reprocess':
      return { target_stage: body.kind === 'reprocess' ? body.stage : null };
    case 'approve':
      return {
        target_stage: APPROVE_FORWARD_STAGE[reason] ?? null,
        reviewer_classification_written: reason === 'classifier_uncertain',
      };
    case 'correct_extraction':
      return body.kind === 'correct_extraction'
        ? { ...body.enums, target_stage: 'verbatim-pii-scan' }
        : { target_stage: 'verbatim-pii-scan' };
    default:
      return {};
  }
}

async function transcriptPresent(client: PoolClient, callId: string): Promise<boolean> {
  const rows = await query(
    client,
    `SELECT 1 FROM raw_transcripts
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows.length > 0;
}
async function cleanTranscriptLive(client: PoolClient, callId: string): Promise<boolean> {
  const rows = await query(
    client,
    `SELECT 1 FROM clean_transcripts
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows.length > 0;
}
async function candidateLive(client: PoolClient, callId: string): Promise<boolean> {
  const rows = await query(
    client,
    `SELECT 1 FROM extraction_candidates
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Artifact/retention preflight for a reprocess-class re-entry, run INSIDE the handler tx after the
 * review + call_state rows are locked (so a raw purge / artifact deletion cannot race in between).
 * A miss throws {@link ReviewConflictError} → rollback → 409 with no audit/outbox/state change.
 */
async function preflight(
  client: PoolClient,
  input: {
    action: ReviewAction;
    targetStage: PipelineStage;
    review: LockedReview & { raw_purged_at: Date | null; created_at: Date };
    now: Date;
    config: Config;
  },
): Promise<void> {
  const { targetStage, review, now, config } = input;
  const callId = review.call_id;
  switch (targetStage) {
    case 'fetch-transcript':
      // Window only — fetching a not-yet-present transcript is the point.
      if (!rawRetentionWindowOpen(review, now, config)) throw new ReviewConflictError();
      return;
    case 'transcript-availability':
    case 'redact':
      if (
        !rawTranscriptRevealAllowed(review, now, config, await transcriptPresent(client, callId))
      ) {
        throw new ReviewConflictError();
      }
      return;
    case 'classify':
    case 'extract':
      if (!(await cleanTranscriptLive(client, callId))) throw new ReviewConflictError();
      return;
    case 'verbatim-pii-scan':
      if (!(await cleanTranscriptLive(client, callId))) throw new ReviewConflictError();
      // correct_extraction CREATES the candidate in-tx; every other verbatim-pii-scan re-entry
      // requires the existing live candidate.
      if (input.action !== 'correct_extraction' && !(await candidateLive(client, callId))) {
        throw new ReviewConflictError();
      }
      return;
    default:
      throw new ReviewConflictError();
  }
}

/** Resolve the active review (assignee ← actor when null). Guarded on the id. */
async function resolveReview(client: PoolClient, reviewId: string, actor: string): Promise<void> {
  await query(
    client,
    `UPDATE review_queue
        SET status = 'resolved', resolved_at = now(), assignee = COALESCE(assignee, $2)
      WHERE id = $1`,
    [reviewId, actor],
  );
}

/** Guarded call_state transition off `held`. Requires exactly one row. */
async function moveCallState(
  client: PoolClient,
  callId: string,
  set: { status: string; currentStage?: string; dropReason?: string | null },
): Promise<void> {
  const rows = await query<{ call_id: string }>(
    client,
    `UPDATE call_state
        SET status = $2,
            current_stage = COALESCE($3, current_stage),
            drop_reason = $4,
            updated_at = now()
      WHERE call_id = $1 AND status = 'held'
      RETURNING call_id`,
    [callId, set.status, set.currentStage ?? null, set.dropReason ?? null],
  );
  if (rows.length !== 1) throw new ReviewConflictError();
}

/**
 * Perform one review action in a single transaction (Task 6.2, plan §"Action model"). Handler
 * template: lock the review by id (any status); an ACTIVE review runs the allow-check, locks
 * call_state, the first-time-execution guard, the in-tx preflight, the transition, ONE audit row
 * (with the `after.action_params` fingerprint), and — for a reprocess-class action — the outbox
 * row; a TERMINAL review is audit-trail idempotency (same action + same fingerprint = no-op, else
 * 409); anything else is 409. A guard/preflight miss throws before any write → rollback.
 *
 * For a reprocess-class action, the reprocess job is enqueued OPTIMISTICALLY after commit and the
 * outbox row marked `sent`; an enqueue failure leaves the durable `pending` row for the
 * reconciliation drain (the action still succeeds).
 */
export async function performReviewAction(
  input: PerformReviewActionInput,
): Promise<ReviewActionResult> {
  const { pool, config, now, action, reviewId, body, actor } = input;

  const committed = await withTransaction(pool, async (client) => {
    const revRows = await query<LockedReview & { raw_purged_at: Date | null; created_at: Date }>(
      client,
      `SELECT id, status, call_id, held_reason, raw_purged_at, created_at
         FROM review_queue WHERE id = $1 FOR UPDATE`,
      [reviewId],
    );
    const review = revRows[0];
    if (!review) throw new ReviewNotFoundError();
    const reason = review.held_reason;

    // --- TERMINAL review: audit-trail idempotency ---
    if (review.status === 'resolved' || review.status === 'unresolvable') {
      const fp = canonical(fingerprintFor(action, reason, body));
      const prior = await listByReview(client, reviewId);
      const match = prior.find((row) => {
        if (row.action !== action) return false;
        const params =
          row.after && typeof row.after === 'object' && !Array.isArray(row.after)
            ? ((row.after as Record<string, JsonValue>).action_params ?? {})
            : {};
        return canonical(params) === fp;
      });
      if (match) return { outcome: 'noop' as const, enqueue: null };
      throw new ReviewConflictError();
    }

    // --- ACTIVE review (open|in_review) ---
    if (review.status !== 'open' && review.status !== 'in_review') {
      throw new ReviewConflictError();
    }
    if (!isActionAllowed(reason, action)) throw new ReviewConflictError();

    // Lock call_state and assert the first-time-execution guard.
    const csRows = await query<LockedCallState>(
      client,
      `SELECT status, current_stage, drop_reason FROM call_state WHERE call_id = $1 FOR UPDATE`,
      [review.call_id],
    );
    const cs = csRows[0];
    if (!cs || cs.status !== 'held' || cs.drop_reason !== null) throw new ReviewConflictError();
    const origins = ORIGIN_STAGES[reason] as readonly string[];
    if (origins.length > 0 && !origins.includes(cs.current_stage)) throw new ReviewConflictError();

    const before: JsonValue = { review_status: review.status, call_state_status: 'held' };
    const fingerprint = fingerprintFor(action, reason, body);
    let after: JsonValue;
    let outbox: { targetStage: PipelineStage } | null = null;

    if (action === 'reject' || action === 'mark_spam') {
      await moveCallState(client, review.call_id, { status: 'review_closed' });
      await resolveReview(client, reviewId, actor);
      after = { review_status: 'resolved', call_state_status: 'review_closed', action_params: {} };
    } else if (action === 'mark_non_customer') {
      await moveCallState(client, review.call_id, {
        status: 'skipped',
        currentStage: 'classify',
        dropReason: 'classified_non_customer',
      });
      await resolveReview(client, reviewId, actor);
      after = { review_status: 'resolved', call_state_status: 'skipped', action_params: {} };
    } else if (action === 'mark_unresolvable') {
      const t = await markUnresolvableByReviewId(client, reviewId, actor);
      after = { ...t.after, action_params: {} };
    } else {
      // reprocess-class: reprocess | approve | correct_extraction.
      const targetStage: PipelineStage =
        action === 'reprocess'
          ? assertReprocessStage(reason, body, config.NODE_ENV)
          : action === 'approve'
            ? requireApproveStage(reason)
            : 'verbatim-pii-scan';

      await preflight(client, { action, targetStage, review, now, config });

      if (action === 'approve' && reason === 'classifier_uncertain') {
        // extract's classify-guard passes only for a `customer` marker.
        await recordReviewerClassification(client, review.call_id);
      }
      if (action === 'correct_extraction') {
        await writeCorrectionCandidate(client, review.call_id, body);
      }

      await moveCallState(client, review.call_id, {
        status: 'processing',
        currentStage: targetStage,
        dropReason: null,
      });
      await resolveReview(client, reviewId, actor);
      after = {
        review_status: 'resolved',
        call_state_status: 'processing',
        action_params: fingerprint,
      };
      outbox = { targetStage };
    }

    const auditRow = await recordOperatorAction(client, {
      reviewQueueId: reviewId,
      actor,
      action,
      before,
      after,
    });

    if (outbox) {
      await insertReprocessRequest(client, {
        operatorActionId: auditRow.id,
        callId: review.call_id,
        reviewQueueId: reviewId,
        targetStage: outbox.targetStage,
        requestedBy: actor,
        priorStage: cs.current_stage,
        priorStatus: cs.status,
        priorDropReason: cs.drop_reason,
      });
      return {
        outcome: 'ok' as const,
        enqueue: { callId: review.call_id, reviewId, outboxActionId: auditRow.id },
      };
    }
    return { outcome: 'ok' as const, enqueue: null };
  });

  // Optimistic post-commit enqueue for a reprocess-class action; a failure leaves the durable
  // `pending` outbox row for the reconciliation drain — the action still succeeded.
  if (committed.enqueue) {
    const { callId, reviewId: rid } = committed.enqueue;
    try {
      await enqueueReprocess(input.queue, callId, config, rid);
      await markReprocessSentByAction(input.pool, committed.enqueue.outboxActionId, now);
    } catch (err) {
      input.logger.warn(
        { component: 'review-surface', call_id: callId },
        `reprocess enqueue failed post-commit; left pending for drain: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }

  return { outcome: committed.outcome, action };
}

/** Validate the reprocess stage against the reason's allowed set; else REQUEST_MALFORMED (400). */
function assertReprocessStage(
  reason: HeldReason,
  body: ReviewActionBody,
  environment: string,
): PipelineStage {
  if (body.kind !== 'reprocess') throw httpFailure('REQUEST_MALFORMED', environment);
  const allowed = REPROCESS_STAGES[reason] as readonly string[];
  if (!allowed.includes(body.stage)) {
    // A syntactically valid stage that is not a permitted reprocess target for this held_reason.
    throw httpFailure('REQUEST_MALFORMED', environment);
  }
  return body.stage;
}

function requireApproveStage(reason: HeldReason): PipelineStage {
  const stage = APPROVE_FORWARD_STAGE[reason];
  if (!stage) throw new ReviewConflictError();
  return stage;
}

/** Write the human-review correction candidate — enums only, every text field a safe constant. */
async function writeCorrectionCandidate(
  client: PoolClient,
  callId: string,
  body: ReviewActionBody,
): Promise<void> {
  if (body.kind !== 'correct_extraction') throw new ReviewConflictError();
  await upsertExtractionCandidate(client, {
    callId,
    callIntent: body.enums.call_intent,
    serviceCategory: body.enums.service_category,
    problemStatement: HUMAN_REVIEW_PROBLEM_STATEMENT,
    symptoms: [],
    customerLanguage: [],
    locationInHome: null,
    accessOrSchedulingNotes: null,
    priorAttempts: null,
    urgency: body.enums.urgency,
    concerns: [],
    sentiment: body.enums.sentiment,
    acquisitionSource: null,
    competitorMentions: [],
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    promptVersion: HUMAN_REVIEW_PROMPT_VERSION,
    modelId: HUMAN_REVIEW_MODEL_ID,
  });
}

/** Mark the outbox row for an action `sent` after a successful optimistic enqueue (guarded on
 * `status='pending'` so the reconciliation drain can't be clobbered). */
async function markReprocessSentByAction(
  pool: Pool,
  operatorActionId: string,
  now: Date,
): Promise<void> {
  await query(
    pool,
    `UPDATE reprocess_requests SET status = 'sent', sent_at = $2
      WHERE operator_action_id = $1 AND status = 'pending'`,
    [operatorActionId, now],
  );
}
