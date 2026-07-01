// SEAM(Task 2.2): this is a minimal, worker-local failure-model shim. When Task 2.2's shared
// failure-model modules land (typed error object, severity map, alert formatter, dedup +
// escalation), replace the constants and sanitizeFailure() here with calls into them.

import type { JsonValue } from '../db/index.js';
import { PipelineStageError, safeErrorCode, safeErrorName } from '../pipeline/errors.js';

/** Error code for a job that exhausted its capped retries (CLAUDE.md §4 taxonomy). */
export const QUEUE_RETRY_EXHAUSTED = 'QUEUE_RETRY_EXHAUSTED';

/** Alert code emitted when a dead-letter row is created (CLAUDE.md §4 taxonomy). */
export const DEAD_LETTER_CREATED = 'DEAD_LETTER_CREATED';

/** The minimal shape of a BullMQ job this module reads. */
export interface FailedJobLike {
  id?: string | undefined;
  attemptsMade: number;
  data: { callId?: unknown };
}

export interface SanitizedFailure {
  /** The stage that failed, or `unknown` — a plain string, safe to use directly. */
  failedStage: string;
  /** A short, PII-free string for the `dead_letter.last_error` column. */
  shortMessage: string;
  /** A PII-free object for `failure_snapshot`. No raw error message, no content. */
  snapshot: Record<string, JsonValue>;
}

function callIdOf(job: FailedJobLike): string | null {
  const raw = job.data.callId;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Build fail-closed, PII-free failure metadata from a failed job and its error.
 *
 * The failed stage comes from {@link PipelineStageError} when present (the runner wraps every
 * stage throw), else `unknown`. We record ONLY the error's class name and an optional safe
 * code — never `err.message`, since future stages touch transcript-adjacent data.
 */
export function sanitizeFailure(job: FailedJobLike, err: unknown): SanitizedFailure {
  // Both branches go through the same fail-closed whitelist: a PipelineStageError already
  // sanitized its cause; a raw error is sanitized here. Neither persists free-text name/code.
  const failedStage = err instanceof PipelineStageError ? err.stage : 'unknown';
  const errorName = err instanceof PipelineStageError ? err.causeName : safeErrorName(err);
  const errorCode = err instanceof PipelineStageError ? err.causeCode : safeErrorCode(err);

  const callId = callIdOf(job);
  const shortMessage = `Stage ${failedStage} failed: ${errorName}${errorCode ? ` (${errorCode})` : ''}`;

  const snapshot: Record<string, JsonValue> = {
    call_id: callId,
    job_id: job.id ?? null,
    attempts_made: job.attemptsMade,
    failed_stage: failedStage,
    error_name: errorName,
    ...(errorCode ? { error_code: errorCode } : {}),
  };

  return { failedStage, shortMessage, snapshot };
}
