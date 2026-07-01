import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { appendLog } from '../db/repositories/processing-log-repo.js';
import { createCallLogger } from '../logging/logger.js';
import { runPipeline } from '../pipeline/state-machine.js';
import { defaultStageHandlers, type StageHandlers } from '../pipeline/stages.js';
import type { PipelineJobData } from '../queue/pipeline-queue.js';
import { handleExhaustedJob } from './dead-letter.js';
import { QUEUE_RETRY_EXHAUSTED, sanitizeFailure } from './errors.js';

export interface PipelineWorkerOptions {
  /** Stage handlers; injectable so tests can force a stage to fail. Defaults to the stubs. */
  handlers?: StageHandlers;
  /** Parent logger; per-call child loggers are derived from it. */
  logger?: Logger;
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
  const { snapshot, failedStage } = sanitizeFailure(job, err);
  const callId = typeof job.data.callId === 'string' ? job.data.callId : null;
  // Source of truth is the JOB'S own attempts (set at enqueue), not the worker's current
  // config — a job that outlived a redeploy/config change must still dead-letter exactly when
  // BullMQ stops retrying it, never too early or never.
  const maxAttempts = job.opts.attempts ?? config.WORKER_MAX_ATTEMPTS;
  const exhausted = job.attemptsMade >= maxAttempts;

  await appendLog(pool, {
    callId,
    stage: failedStage,
    outcome: 'failed',
    ...(exhausted ? { errorCode: QUEUE_RETRY_EXHAUSTED } : {}),
    failureSnapshot: snapshot,
  });

  if (exhausted) {
    await handleExhaustedJob(pool, job, err, logger);
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
  const handlers = options.handlers ?? defaultStageHandlers;
  const parentLogger = options.logger;

  const worker = new Worker<PipelineJobData>(
    config.WORKER_QUEUE_NAME,
    async (job) => {
      const callId = job.data.callId;
      const callLogger = createCallLogger(callId, parentLogger);
      await runPipeline(pool, callId, callLogger, handlers);
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
