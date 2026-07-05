import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { createFailure, dedupKey, failureSnapshot } from '../failure-model/index.js';
import { recordAlert } from '../db/repositories/alert-events-repo.js';
import { recordDeadLetter } from '../db/repositories/dead-letter-repo.js';
import {
  DEAD_LETTER_CREATED,
  QUEUE_RETRY_EXHAUSTED,
  failureContext,
  sanitizeFailure,
  type FailedJobLike,
} from './errors.js';

/**
 * A job exhausted its capped retries. Persist a `dead_letter` row and emit exactly one
 * actionable `DEAD_LETTER_CREATED` alert (the shared dedup key guarantees one per call).
 * Both the dead-letter row and the alert carry the full §4 `failure_snapshot` from the shared
 * failure-model catalog, so the failure stays explainable after the alert is gone (Task 7.4);
 * the sanitized diagnostic (failed stage, error class) rides in `dead_letter.last_error`.
 * Called from the worker's `failed` handler on the final attempt.
 */
export async function handleExhaustedJob(
  pool: Pool,
  job: FailedJobLike,
  err: unknown,
  logger: Logger,
): Promise<void> {
  const { shortMessage, snapshot: diagnostic, failedStage } = sanitizeFailure(job, err);
  const callId = typeof job.data.callId === 'string' ? job.data.callId : null;
  const context = failureContext(callId, job.id, failedStage);

  const deadLetterFailure = createFailure(QUEUE_RETRY_EXHAUSTED, {
    processingState: 'continuing', // the pipeline keeps processing other calls; this one is parked
    context,
  });
  await recordDeadLetter(pool, {
    callId,
    jobPayload: { callId },
    errorCode: QUEUE_RETRY_EXHAUSTED,
    rootCauseCategory: QUEUE_RETRY_EXHAUSTED,
    lastError: shortMessage,
    failureSnapshot: failureSnapshot(deadLetterFailure),
  });

  const alertFailure = createFailure(DEAD_LETTER_CREATED, {
    processingState: 'continuing',
    context,
  });
  await recordAlert(pool, {
    errorCode: alertFailure.error_code,
    rootCauseCategory: alertFailure.root_cause_category,
    severity: alertFailure.severity,
    dedupKey: dedupKey(alertFailure),
    failureSnapshot: failureSnapshot(alertFailure),
  });

  logger.error(
    { error_code: QUEUE_RETRY_EXHAUSTED, ...diagnostic },
    'job exhausted retries — moved to dead_letter',
  );
}
