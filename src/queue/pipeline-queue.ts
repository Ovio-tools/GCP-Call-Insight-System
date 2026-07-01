import { createHash } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Config } from '../config/schema.js';

/** The single job name on the pipeline queue — one job type: "run this call's pipeline". */
export const PIPELINE_JOB_NAME = 'run-pipeline';

/** Payload carried by every pipeline job. The processor reads `callId` from here. */
export interface PipelineJobData {
  callId: string;
}

/**
 * Deterministic, Redis-safe job id for a call.
 *
 * Dialpad / ServiceTitan call IDs are external and may contain characters BullMQ and Redis
 * treat specially — BullMQ outright REJECTS a custom job id containing `:`, and spaces/unicode
 * are possible — so the raw `callId` is never used as the `jobId`. A sha256 (base64url) is
 * deterministic, so duplicate enqueues of the same call still collapse to one job, while the
 * id is always a clean `[A-Za-z0-9_-]` token (base64url has no `:`). The original `callId`
 * lives in the job payload.
 */
export function jobIdForCall(callId: string): string {
  const digest = createHash('sha256').update(callId, 'utf8').digest('base64url');
  return `call-${digest}`;
}

/** Job options derived from config: capped attempts, exponential backoff, bounded retention. */
export function pipelineJobOptions(config: Config, callId: string): JobsOptions {
  return {
    jobId: jobIdForCall(callId),
    attempts: config.WORKER_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: config.WORKER_BACKOFF_MS },
    // Keep Redis bounded: retain a small window of finished jobs for inspection, then evict.
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };
}

/** Create the BullMQ queue for the per-call pipeline. */
export function createPipelineQueue(config: Config, connection: Redis): Queue<PipelineJobData> {
  return new Queue<PipelineJobData>(config.WORKER_QUEUE_NAME, { connection });
}

/**
 * Enqueue a call for processing. Keyed by `call_id` via {@link jobIdForCall}, so duplicate
 * concurrent/pending enqueues collapse to a single job — the idempotency guarantee.
 *
 * Dedup holds while a job with that id is still live in Redis; once a completed job is
 * evicted by `removeOnComplete`, a genuinely new enqueue creates a fresh job. That is
 * correct reprocessing — and `runPipeline`'s terminal no-op guard keeps a re-enqueued
 * already-completed call from re-running its stages.
 */
export async function enqueueCall(
  queue: Queue<PipelineJobData>,
  callId: string,
  config: Config,
): Promise<void> {
  await queue.add(PIPELINE_JOB_NAME, { callId }, pipelineJobOptions(config, callId));
}
