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

/**
 * Deterministic job id for a REVIEW-driven reprocess (Task 6.2). Distinct from the base
 * {@link jobIdForCall} id so it never dedups against a retained COMPLETED base job lingering in
 * the `removeOnComplete` set — that dedup would silently drop the reprocess. Scoped by review id
 * (a review is resolved by the action that enqueues its reprocess, so at most one reprocess per
 * review). Stays a clean `[A-Za-z0-9_-]` token: base64url + uuid, no `:` (which BullMQ rejects).
 */
export function reprocessJobId(callId: string, reviewQueueId: string): string {
  return `${jobIdForCall(callId)}-reprocess-${reviewQueueId}`;
}

/** Minimal queue surface {@link enqueueReprocess} needs — BullMQ's `Queue` satisfies it. */
export interface ReprocessQueue {
  add(name: string, data: PipelineJobData, opts: JobsOptions & { jobId: string }): Promise<unknown>;
}

/**
 * Enqueue a review-driven reprocess of a call (Task 6.2). The `call_state` transition that
 * precedes this already moved the call to `status='processing'` at the target stage, so the
 * runner resumes from `current_stage`; this only schedules the job. Uses {@link reprocessJobId}
 * so a retained completed base job can never dedup it away. Idempotent within a review: the
 * reconciliation-cron drain and the optimistic post-commit enqueue both use this id, so a retry
 * collapses onto the same job.
 */
export async function enqueueReprocess(
  queue: ReprocessQueue,
  callId: string,
  config: Config,
  reviewQueueId: string,
): Promise<void> {
  await queue.add(
    PIPELINE_JOB_NAME,
    { callId },
    { ...pipelineJobOptions(config, callId), jobId: reprocessJobId(callId, reviewQueueId) },
  );
}

/**
 * Deterministic job id for a one-shot RE-EXTRACT backfill (recategorize historical calls, e.g.
 * after adding a service_category). Like {@link reprocessJobId} it is distinct from the base
 * {@link jobIdForCall} id so it never dedups against a retained COMPLETED base job in the
 * `removeOnComplete` set, and distinct from the reprocess id so a review reprocess and a backfill
 * of the same call don't collide. Scoped by a per-run token so re-running the backfill (new run)
 * creates fresh jobs while a single run stays idempotent. Clean `[A-Za-z0-9_-]` token (no `:`).
 */
export function reextractJobId(callId: string, runId: string): string {
  return `${jobIdForCall(callId)}-reextract-${runId}`;
}

/**
 * Enqueue a re-extract of a call for the recategorize backfill. The `call_state` transition that
 * precedes this already moved the call to `status='processing'` at `current_stage='extract'`, so
 * the runner resumes at extract; this only schedules the job. Uses {@link reextractJobId} so a
 * retained completed base job can never dedup it away.
 */
export async function enqueueReextract(
  queue: ReprocessQueue,
  callId: string,
  config: Config,
  runId: string,
): Promise<void> {
  await queue.add(
    PIPELINE_JOB_NAME,
    { callId },
    { ...pipelineJobOptions(config, callId), jobId: reextractJobId(callId, runId) },
  );
}

/** Minimal queue surface the fetch-transcript stage needs — BullMQ's `Queue` satisfies it. */
export interface DelayedRetryQueue {
  add(
    name: string,
    data: PipelineJobData,
    opts: JobsOptions & { jobId: string; delay: number },
  ): Promise<unknown>;
}

/**
 * Re-enqueue a call as a DELAYED job when its transcript isn't ready yet (fetch-transcript's
 * bounded wait). The base `jobIdForCall` job may already be finished (and lingering in the
 * `removeOnComplete` set), so a distinct, poll-slot-scoped job id is used — otherwise BullMQ
 * would dedup the retry away and it would be silently lost. The id stays a clean
 * `[A-Za-z0-9_-]` token (no `:`, which BullMQ rejects). `slot` makes it idempotent within a
 * poll window: two runners observing the same not-ready state schedule the same id once.
 */
export async function enqueueTranscriptRetry(
  queue: DelayedRetryQueue,
  callId: string,
  config: Config,
  opts: { delayMs: number; slot: number },
): Promise<void> {
  await queue.add(
    PIPELINE_JOB_NAME,
    { callId },
    {
      ...pipelineJobOptions(config, callId),
      jobId: `${jobIdForCall(callId)}-wait-${opts.slot}`,
      delay: opts.delayMs,
    },
  );
}
