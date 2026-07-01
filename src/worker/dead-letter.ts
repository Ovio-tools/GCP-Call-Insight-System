import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { recordAlert } from '../db/repositories/alert-events-repo.js';
import { recordDeadLetter } from '../db/repositories/dead-letter-repo.js';
import {
  DEAD_LETTER_CREATED,
  QUEUE_RETRY_EXHAUSTED,
  sanitizeFailure,
  type FailedJobLike,
} from './errors.js';

// SEAM(Task 2.2): dead-letter + alert emission go directly through the DAL for now. Swap the
// severity/dedup/format decisions below for Task 2.2's shared failure-model modules once built.

/**
 * A job exhausted its capped retries. Persist a `dead_letter` row with sanitized root-cause
 * metadata and emit exactly one actionable `DEAD_LETTER_CREATED` alert (the dedup key
 * guarantees one per call). Called from the worker's `failed` handler on the final attempt.
 */
export async function handleExhaustedJob(
  pool: Pool,
  job: FailedJobLike,
  err: unknown,
  logger: Logger,
): Promise<void> {
  const { shortMessage, snapshot } = sanitizeFailure(job, err);
  const callId = typeof job.data.callId === 'string' ? job.data.callId : null;

  await recordDeadLetter(pool, {
    callId,
    jobPayload: { callId },
    errorCode: QUEUE_RETRY_EXHAUSTED,
    rootCauseCategory: QUEUE_RETRY_EXHAUSTED,
    lastError: shortMessage,
    failureSnapshot: snapshot,
  });

  await recordAlert(pool, {
    errorCode: DEAD_LETTER_CREATED,
    rootCauseCategory: DEAD_LETTER_CREATED,
    severity: 'high',
    dedupKey: `dead_letter:${callId ?? job.id ?? 'unknown'}`,
    failureSnapshot: snapshot,
  });

  logger.error(
    { error_code: QUEUE_RETRY_EXHAUSTED, ...snapshot },
    'job exhausted retries — moved to dead_letter',
  );
}
