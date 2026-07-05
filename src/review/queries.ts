import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import { getReview, listOpen } from '../db/repositories/review-queue-repo.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { getStructuredKnowledge } from '../db/repositories/structured-knowledge-repo.js';
import { transcriptExists } from '../db/repositories/raw-transcripts-repo.js';
import type { ReviewQueueRow } from '../db/schemas/review-queue.js';
import { ALLOWED_ACTIONS } from './action-matrix.js';
import { explanationFor } from './explanations.js';
import { slaState } from './sla-state.js';
import { rawTranscriptRevealAllowed } from './raw-access.js';
import { guardRedactedContent } from './redacted-content-guard.js';
import { type ReviewDetail, type ReviewList, type ReviewListItem } from './dto.js';
import { serializeReviewDetail, serializeReviewList } from './serialize.js';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Map a review row to its safe list-item DTO. */
function toListItem(row: ReviewQueueRow, now: Date): ReviewListItem {
  return {
    id: row.id,
    call_id: row.call_id,
    held_reason: row.held_reason,
    explanation: explanationFor(row.held_reason),
    status: row.status,
    assignee: row.assignee,
    sla_due_at: iso(row.sla_due_at),
    sla_state: slaState(row.sla_due_at, now),
    escalated: row.escalated_at !== null,
    raw_purged: row.raw_purged_at !== null,
    created_at: row.created_at.toISOString(),
    resolved_at: iso(row.resolved_at),
  };
}

/** The open-review list (safe fields only), serialized through the no-egress backstop. */
export async function buildReviewList(pool: Pool, now: Date): Promise<ReviewList> {
  const rows = await listOpen(pool);
  return serializeReviewList({
    items: rows.map((r) => toListItem(r, now)),
    generated_at: now.toISOString(),
  });
}

/**
 * One review item's detail (Task 6.2): safe list fields + `raw_available` (metadata-only, no
 * decrypt) + redacted content (only from a live clean row that passes a value-level residual
 * scan) + the four extracted enums when a completed record exists + the allowed actions.
 * Returns undefined when the review id is unknown (→ the route 404s).
 */
export async function buildReviewDetail(
  pool: Pool,
  config: Config,
  now: Date,
  reviewId: string,
  denyTerms: readonly string[],
): Promise<ReviewDetail | undefined> {
  const review = await getReview(pool, reviewId);
  if (!review) return undefined;
  const callId = review.call_id;
  const isActive = review.status === 'open' || review.status === 'in_review';

  const present = await transcriptExists(pool, callId);
  const rawAvailable = rawTranscriptRevealAllowed(review, now, config, present);

  // Redacted content: only from a LIVE clean row, and only if it passes a value-level residual
  // scan (defense in depth over the redact-stage outputSafe invariant).
  let redactedAvailable = false;
  let redactedContent: string | null = null;
  let withheldReason: ReviewDetail['redacted_content_withheld_reason'] = null;
  const clean = await getCleanTranscript(pool, callId);
  if (!clean) {
    withheldReason = 'no_clean_transcript';
  } else {
    const guard = guardRedactedContent(clean.redacted_text, denyTerms);
    if (guard.safe) {
      redactedAvailable = true;
      redactedContent = clean.redacted_text;
    } else {
      withheldReason = 'residual_pii';
    }
  }

  // The four enums when a completed structured record exists (rare for a held call — store only
  // writes passed candidates — but supported for a resolved review being viewed).
  const sk = await getStructuredKnowledge(pool, callId);
  const extracted = sk
    ? {
        call_intent: sk.call_intent,
        service_category: sk.service_category,
        urgency: sk.urgency,
        sentiment: sk.sentiment,
      }
    : null;

  const dto: ReviewDetail = {
    ...toListItem(review, now),
    raw_available: rawAvailable,
    redacted_content_available: redactedAvailable,
    redacted_content: redactedContent,
    redacted_content_withheld_reason: withheldReason,
    extracted: extracted,
    allowed_actions: isActive ? [...ALLOWED_ACTIONS[review.held_reason]].sort() : [],
  };
  // serializeReviewDetail re-validates against the DTO schema (whose enum fields reject a drifted
  // structured_knowledge service_category/sentiment rather than shipping it) and runs the
  // no-content-field guard.
  return serializeReviewDetail(dto);
}
