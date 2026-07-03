import type { Logger } from 'pino';

/**
 * Uniform structured logging for the per-call pipeline stages (Task 7.4): every stage logs a
 * START line and exactly one END line (success or failure). Only an ALLOWLISTED set of fields
 * is ever emitted — call_id, stage, outcome, error_code, duration_ms, attempt, job_id — so a
 * log line can never carry transcript content, customer_language, or PII. `call_id` is emitted
 * on EVERY line by these helpers, so the Task 7.4 traceability contract holds regardless of
 * whether the caller passed a call-scoped child logger; the logger's `assertNoContentFields`
 * hook is the belt-and-suspenders guard.
 */

/** The controlled outcome vocabulary for a stage END line; mirrors the processing_log outcomes. */
export type StageEndOutcome = 'completed' | 'skipped' | 'held' | 'deferred' | 'failed';

export interface StageEndFields {
  /** The call this stage line belongs to — emitted on every line for end-to-end tracing. */
  callId: string;
  stage: string;
  outcome: StageEndOutcome;
  /** Failure-model error code, on a failing/held end. */
  errorCode?: string;
  /** Wall-clock time the handler took, where practical. */
  durationMs?: number;
  /** BullMQ attempt number, where the caller has it (worker/runner). */
  attempt?: number;
  /** BullMQ job id, where the caller has it. */
  jobId?: string;
}

/** Assemble the allowlisted structured bindings for a stage END line. */
function endBindings(f: StageEndFields): Record<string, string | number> {
  return {
    call_id: f.callId,
    stage: f.stage,
    event: 'stage_end',
    outcome: f.outcome,
    ...(f.errorCode !== undefined ? { error_code: f.errorCode } : {}),
    ...(f.durationMs !== undefined ? { duration_ms: f.durationMs } : {}),
    ...(f.attempt !== undefined ? { attempt: f.attempt } : {}),
    ...(f.jobId !== undefined ? { job_id: f.jobId } : {}),
  };
}

/** Log that a stage began. */
export function logStageStart(logger: Logger, fields: { callId: string; stage: string }): void {
  logger.info(
    { call_id: fields.callId, stage: fields.stage, event: 'stage_start', outcome: 'started' },
    'stage started',
  );
}

/** Log a successful (or otherwise non-failure) stage end at info level. */
export function logStageSuccess(logger: Logger, fields: StageEndFields): void {
  logger.info(endBindings(fields), 'stage finished');
}

/** Log a failing/held stage end at warn level, carrying the error_code. */
export function logStageFailure(logger: Logger, fields: StageEndFields): void {
  logger.warn(endBindings(fields), 'stage failed');
}
