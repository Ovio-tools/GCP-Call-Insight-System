import { DelayedError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { appendLog } from '../db/repositories/processing-log-repo.js';
import { getCallState } from '../db/repositories/call-state-repo.js';
import { BACKFILL_SYNTHETIC_SOURCE } from '../backfill/ingest.js';
import { createCallLogger } from '../logging/logger.js';
import { runPipeline } from '../pipeline/state-machine.js';
import type { StageHandlers } from '../pipeline/stages.js';
import { productionStageHandlers } from '../pipeline/handlers.js';
import { slaMinutesFor } from '../review-queue/sla.js';
import type { PipelineJobData } from '../queue/pipeline-queue.js';
import { createFailure, failureSnapshot } from '../failure-model/index.js';
import { handleExhaustedJob } from './dead-letter.js';
import { QUEUE_RETRY_EXHAUSTED, failureContext, sanitizeFailure } from './errors.js';

export interface PipelineWorkerOptions {
  /** Stage handlers; injectable so tests can force a stage to fail. Defaults to the stubs. */
  handlers?: StageHandlers;
  /** Parent logger; per-call child loggers are derived from it. */
  logger?: Logger;
  /**
   * Defensive maintenance backstop (Task 8.2). When present and it resolves `true`, a job the
   * worker had ALREADY fetched before a key-rotation pause landed is re-delayed via
   * `moveToDelayed` + `DelayedError` — so BullMQ neither completes nor fails it and, critically,
   * does NOT increment `attemptsMade`. The primary pause is the global `queue.pause()`; this only
   * covers the fetched-but-not-yet-run window.
   */
  isMaintenanceActive?: () => Promise<boolean>;
}

/**
 * A job failed (one attempt). Always append a `processing_log` failure row for the audit
 * trail; when the capped retries are exhausted, move the job to `dead_letter` and emit the
 * single `DEAD_LETTER_CREATED` alert. All persisted metadata is PII-free (see sanitizeFailure).
 */
async function onJobFailed(
  pool: Pool,
  config: Config,
  job: Job<PipelineJobData>,
  err: unknown,
  logger: Logger,
): Promise<void> {
  const { snapshot: diagnostic, failedStage } = sanitizeFailure(job, err);
  const callId = typeof job.data.callId === 'string' ? job.data.callId : null;
  // Source of truth is the JOB'S own attempts (set at enqueue), not the worker's current
  // config — a job that outlived a redeploy/config change must still dead-letter exactly when
  // BullMQ stops retrying it, never too early or never.
  const maxAttempts = job.opts.attempts ?? config.WORKER_MAX_ATTEMPTS;
  const exhausted = job.attemptsMade >= maxAttempts;

  if (exhausted) {
    // Terminal failure: the audit row carries the full §4 snapshot (QUEUE_RETRY_EXHAUSTED) so
    // it stays explainable, with the sanitized diagnostic (attempts, error class) in `detail`.
    const failure = createFailure(QUEUE_RETRY_EXHAUSTED, {
      processingState: 'continuing',
      context: failureContext(callId, job.id, failedStage),
    });
    await appendLog(pool, {
      callId,
      stage: failedStage,
      outcome: 'failed',
      errorCode: QUEUE_RETRY_EXHAUSTED,
      detail: diagnostic,
      failureSnapshot: failureSnapshot(failure),
    });
    await handleExhaustedJob(pool, job, err, logger);
  } else {
    // A still-retrying attempt: no terminal code yet, so record the sanitized diagnostic in
    // `detail` (the call is not the failure of record until retries are exhausted).
    await appendLog(pool, {
      callId,
      stage: failedStage,
      outcome: 'failed',
      detail: diagnostic,
    });
  }
}

/**
 * Build the pipeline worker. Constructed with `autorun: false` so the caller decides when to
 * start consuming — the kill switch gates that call, letting jobs accumulate untouched in
 * Redis without ever being lost.
 */
export function createPipelineWorker(
  config: Config,
  pool: Pool,
  connection: Redis,
  options: PipelineWorkerOptions = {},
): Worker<PipelineJobData> {
  const handlers = options.handlers ?? productionStageHandlers;
  const parentLogger = options.logger;
  const isMaintenanceActive = options.isMaintenanceActive;
  const requeueDelayMs = config.KEY_ROTATION_MAINTENANCE_REQUEUE_DELAY_MS;

  const worker = new Worker<PipelineJobData>(
    config.WORKER_QUEUE_NAME,
    async (job, token) => {
      // Maintenance backstop: a key rotation paused the queue, but this job was already fetched.
      // Re-delay it WITHOUT consuming a retry (moveToDelayed + DelayedError) so rotation can
      // re-encrypt raw/vault rows uncontended; the job resumes after `requeueDelayMs`.
      if (isMaintenanceActive && (await isMaintenanceActive())) {
        await job.moveToDelayed(Date.now() + requeueDelayMs, token);
        throw new DelayedError();
      }
      const callId = job.data.callId;
      const callLogger = createCallLogger(callId, parentLogger);
      // Defense-in-depth (Task 11.2, R4 #1): a staging-synthetic backfill call must NEVER be
      // processed by a real worker. Synthetic runs execute in-process against a fixture-backed
      // Dialpad client and are never enqueued; if one somehow reached the shared queue, refuse it
      // here as a logged no-op rather than run redaction/model stages on fixture data.
      const state = await getCallState(pool, callId);
      if (state?.source === BACKFILL_SYNTHETIC_SOURCE) {
        callLogger.warn(
          { source: BACKFILL_SYNTHETIC_SOURCE },
          'refusing a synthetic backfill job on the shared worker (no-op)',
        );
        return;
      }
      await runPipeline(pool, callId, callLogger, {
        handlers,
        slaMinutesFor: (reason) => slaMinutesFor(config, reason),
      });
    },
    { connection, concurrency: config.WORKER_CONCURRENCY, autorun: false },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    void onJobFailed(
      pool,
      config,
      job,
      err,
      parentLogger ?? createCallLogger(job.data.callId),
    ).catch((handlerErr: unknown) => {
      // The failure handler itself failed — surface it, but never throw out of an event
      // listener (BullMQ would swallow it and we'd lose the signal entirely).
      (parentLogger ?? createCallLogger(job.data.callId)).error(
        { error_code: 'DEAD_LETTER_HANDLER_FAILED' },
        `dead-letter handling failed: ${String(handlerErr)}`,
      );
    });
  });

  return worker;
}
