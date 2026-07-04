import type { Queryable } from '../db/types.js';
import { appendLog } from '../db/repositories/processing-log-repo.js';

/**
 * The classify bucket a reviewer approval writes. Only `customer` re-enters the pipeline (the
 * extract stage runs solely for customer calls); the other classify buckets resolve via a
 * terminal action, never `approve`. Kept as a constant so the provenance marker `source` and
 * the value are stated once. */
export const REVIEWER_CLASSIFICATION_SOURCE = 'reviewer_approved' as const;

/**
 * Write a content-free reviewer `customer` classify marker (Task 6.2), used by
 * `approve(classifier_uncertain)` before it reprocesses from `extract`. The extract stage's
 * classification guard (`getLatestClassificationBucket`) only reads `detail->>'bucket'`, so this
 * completed `classify` `processing_log` row makes the guard pass; the extra `source` key keeps
 * the row distinguishable from a model classification in metrics/audits. Enlisted in the
 * caller's transaction via {@link Queryable}. NO transcript content, NO PII — bucket + source
 * constants only.
 */
export async function recordReviewerClassification(db: Queryable, callId: string): Promise<void> {
  await appendLog(db, {
    callId,
    stage: 'classify',
    outcome: 'completed',
    detail: { bucket: 'customer', source: REVIEWER_CLASSIFICATION_SOURCE },
  });
}
