import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import { DialpadError } from '../dialpad/client/index.js';
import {
  type ErrorCode,
  type ProcessingState,
  createFailure,
  dedupKey,
  failureSnapshot,
} from '../failure-model/index.js';
import { recordAlert } from '../db/repositories/alert-events-repo.js';
import {
  markTranscriptWaitStarted,
  seedCallStateIfAbsent,
} from '../db/repositories/call-state-repo.js';
import { putTranscript, transcriptExists } from '../db/repositories/raw-transcripts-repo.js';
import { type DelayedRetryQueue, enqueueTranscriptRetry } from '../queue/pipeline-queue.js';
import {
  PIPELINE_STAGES,
  STATUS_PROCESSING,
  type StageContext,
  type StageHandler,
  type StageResult,
} from './stages.js';

/** Provenance tag for a canonical call rescued into the pipeline because only a
 *  non-canonical leg of the conversation was listed/enqueued. */
const CANONICAL_LEG_SOURCE = 'canonical-leg-rescue';

/** Injected time so the bounded-wait window can be driven deterministically in tests. */
export interface Clock {
  now(): number;
}

export interface FetchTranscriptDeps {
  client: DialpadClient;
  keyProvider: KeyProvider;
  /** Queue used to schedule the delayed not-ready retry (BullMQ `Queue` satisfies this). */
  queue: DelayedRetryQueue;
  config: Config;
  clock?: Clock;
  /** DB-B app pool (Task 8a): raw_transcripts + token_vault live only in the raw store. */
  rawPool: Pool;
  /** Enqueue a pipeline job for a call id (the canonical-leg safeguard). Injected so the stage
   *  stays testable and free of the concrete BullMQ queue type. */
  enqueuePipelineJob: (callId: string) => Promise<void>;
}

/** Map a client `DialpadError` kind to the shared failure-model code + processing state. */
const KIND_TO_FAILURE: Record<
  Exclude<DialpadError['kind'], 'unavailable'>,
  { code: ErrorCode; processingState: ProcessingState }
> = {
  auth: { code: 'DIALPAD_AUTH_FAILED', processingState: 'paused' },
  rate_limited: { code: 'DIALPAD_RATE_LIMITED', processingState: 'degraded' },
  api_changed: { code: 'DIALPAD_API_CHANGED', processingState: 'paused' },
};

/**
 * Persist the deduped alert for a mapped Dialpad failure (auth / rate-limited / api-changed),
 * so the specific code reaches the status surface even before BullMQ exhausts its retries.
 * A transient `unavailable` gets no specific alert — the dead-letter path (DEAD_LETTER_CREATED)
 * covers it. Context is sanitized: only call_id, stage, environment. Never a payload or PII.
 */
async function persistDialpadAlert(
  pool: Pool,
  callId: string,
  stage: string,
  err: DialpadError,
  config: Config,
): Promise<void> {
  if (err.kind === 'unavailable') return;
  const mapped = KIND_TO_FAILURE[err.kind];
  const failure = createFailure(mapped.code, {
    processingState: mapped.processingState,
    context: { call_id: callId, stage, environment: config.NODE_ENV },
  });
  await recordAlert(pool, {
    errorCode: failure.error_code,
    rootCauseCategory: failure.root_cause_category,
    severity: failure.severity,
    dedupKey: dedupKey(failure),
    failureSnapshot: {
      ...failureSnapshot(failure),
      call_id: callId,
      stage,
      status: err.status ?? null,
      attempts: err.attempts,
    },
  });
}

/**
 * Persist the deduped DIALPAD_TRANSCRIPT_MISSING alert. Shared by BOTH missing-transcript
 * paths — the not-ready window timeout and the availability gate — so they behave identically
 * and collapse onto one active alert via the shared dedup key.
 */
async function recordTranscriptMissingAlert(
  pool: Pool,
  ctx: { callId: string; stage: string; environment: string; waitedMs?: number },
): Promise<void> {
  const failure = createFailure('DIALPAD_TRANSCRIPT_MISSING', {
    processingState: 'degraded',
    context: { call_id: ctx.callId, stage: ctx.stage, environment: ctx.environment },
  });
  await recordAlert(pool, {
    errorCode: failure.error_code,
    rootCauseCategory: failure.root_cause_category,
    severity: failure.severity,
    dedupKey: dedupKey(failure),
    failureSnapshot: {
      ...failureSnapshot(failure),
      call_id: ctx.callId,
      stage: ctx.stage,
      ...(ctx.waitedMs !== undefined ? { waited_ms: ctx.waitedMs } : {}),
    },
  });
}

/**
 * The `fetch-transcript` stage handler (Task 3.3). Runs ONLY after the metadata pre-filter
 * passed (a dropped call is `skipped` and never reaches here). Fetches the AI transcript via
 * the Dialpad client, and:
 *  - ready → stores the raw transcript through the envelope-encrypted helper, then advances.
 *  - not-ready → within the wait window, schedules a delayed retry and `defer`s (no failure);
 *    past the window, emits DIALPAD_TRANSCRIPT_MISSING and `hold`s with `missing_transcript`.
 *  - Dialpad failure → persists the mapped alert (auth/rate-limited/api-changed), then rethrows
 *    so BullMQ retries and eventually dead-letters. No transcript content is ever logged.
 */
export function createFetchTranscriptHandler(deps: FetchTranscriptDeps): StageHandler {
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger, pool } = ctx;

    let result;
    try {
      result = await deps.client.fetchTranscript(callId);
    } catch (err) {
      if (err instanceof DialpadError) {
        await persistDialpadAlert(pool, callId, stage, err, deps.config);
      }
      // Propagate: the runner wraps this in PipelineStageError and the worker's retry /
      // dead-letter path takes over. No review_queue hold for these — the call stays
      // recoverable once creds/limit/contract are resolved.
      throw err;
    }

    if (result.kind === 'ready') {
      const canonical = result.canonicalCallId;
      // A leg whose transcript reports a DIFFERENT canonical id is a duplicate of that
      // conversation. Drop it before any model work runs — but first make sure the canonical
      // call itself will be processed, so we never lose a call. Fail-open: an absent canonical
      // id (Dialpad omitted the field) keeps today's behavior.
      if (canonical !== undefined && canonical !== callId) {
        const created = await seedCallStateIfAbsent(pool, {
          callId: canonical,
          source: CANONICAL_LEG_SOURCE,
          currentStage: PIPELINE_STAGES[0],
          status: STATUS_PROCESSING,
        });
        if (created) await deps.enqueuePipelineJob(canonical);
        logger.info(
          { stage, canonical_call_id: canonical, canonical_enqueued: created },
          'non-canonical call leg — dropping duplicate; canonical ensured',
        );
        return {
          action: 'drop',
          reason: 'duplicate_call_leg',
          detail: { canonical_call_id: canonical },
        };
      }

      await putTranscript(deps.rawPool, deps.keyProvider, {
        callId,
        transcript: result.transcript,
      });
      logger.info({ stage }, 'transcript fetched and stored');
      return { action: 'continue' };
    }

    // not-ready: bound the wait against the first-seen timestamp (idempotent stamp).
    const waitStarted = await markTranscriptWaitStarted(pool, callId);
    if (waitStarted === null) {
      throw new Error(`call_state row for ${callId} vanished during transcript wait`);
    }
    const waitedMs = now() - waitStarted.getTime();

    if (waitedMs >= deps.config.DIALPAD_TRANSCRIPT_WAIT_MAX_MS) {
      await recordTranscriptMissingAlert(pool, {
        callId,
        stage,
        environment: deps.config.NODE_ENV,
        waitedMs,
      });
      logger.info(
        { stage, waited_ms: waitedMs },
        'transcript never arrived — holding missing_transcript',
      );
      return {
        action: 'hold',
        reason: 'missing_transcript',
        errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
        detail: { waited_ms: waitedMs },
      };
    }

    // Within the window: schedule a delayed retry (poll-slot-scoped id) and defer.
    const slot = Math.floor(waitedMs / deps.config.DIALPAD_TRANSCRIPT_POLL_MS);
    await enqueueTranscriptRetry(deps.queue, callId, deps.config, {
      delayMs: deps.config.DIALPAD_TRANSCRIPT_POLL_MS,
      slot,
    });
    logger.info({ stage, waited_ms: waitedMs }, 'transcript not ready — deferring retry');
    return { action: 'defer' };
  };
}

/**
 * The `transcript-availability` stage handler: a lightweight gate confirming fetch-transcript
 * actually stored a transcript before redact runs. Checks presence WITHOUT decrypting. This
 * should always pass (fetch-transcript only advances on a successful store); if the row is
 * somehow gone, it fails safe by holding rather than sending an empty transcript downstream.
 */
export function createTranscriptAvailabilityHandler(deps: {
  config: Config;
  /** DB-B app pool (Task 8a): the raw transcript lives only in the raw store. */
  rawPool: Pool;
}): StageHandler {
  return async (ctx: StageContext): Promise<StageResult> => {
    const present = await transcriptExists(deps.rawPool, ctx.callId);
    if (!present) {
      // Same disposition as the not-ready timeout: emit the deduped alert, then hold.
      await recordTranscriptMissingAlert(ctx.pool, {
        callId: ctx.callId,
        stage: ctx.stage,
        environment: deps.config.NODE_ENV,
      });
      ctx.logger.info(
        { stage: ctx.stage },
        'transcript unexpectedly absent at availability gate — holding',
      );
      return {
        action: 'hold',
        reason: 'missing_transcript',
        errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
      };
    }
    ctx.logger.info({ stage: ctx.stage }, 'transcript present');
    return { action: 'continue' };
  };
}
