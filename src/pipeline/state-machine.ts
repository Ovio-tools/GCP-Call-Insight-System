import type { Pool } from 'pg';
import type { Logger } from 'pino';
// Imported from db/errors.js directly (not the db barrel): the model-stage import
// guard forbids pipeline modules from reaching modules that re-export raw/vault access.
import { DalError, DAL_STALE_STAGE } from '../db/errors.js';
import { createFailure, failureSnapshot } from '../failure-model/index.js';
import { logStageFailure, logStageStart, logStageSuccess } from '../logging/stage-log.js';
import {
  advanceStage,
  getCallState,
  holdCall,
  skipCall,
} from '../db/repositories/call-state-repo.js';
import { hasActiveReviewForCall } from '../db/repositories/review-queue-repo.js';
import { PipelineStageError } from './errors.js';
import {
  FINAL_STAGE,
  PIPELINE_STAGES,
  SKIP_STAGES,
  STATUS_COMPLETED,
  STATUS_HELD,
  STATUS_PROCESSING,
  STATUS_SKIPPED,
  defaultStageHandlers,
  isPipelineStage,
  type PipelineStage,
  type StageHandlers,
  type StageResult,
} from './stages.js';

const LAST_INDEX = PIPELINE_STAGES.length - 1;

function isStaleStageError(err: unknown): boolean {
  return err instanceof DalError && err.code === DAL_STALE_STAGE;
}

/**
 * The stage index recorded in the DB, or -1 if `current_stage` is not a known pipeline stage.
 */
function dbStageIndex(currentStage: string): number {
  return (PIPELINE_STAGES as readonly string[]).indexOf(currentStage);
}

type StaleResolution = { kind: 'complete' } | { kind: 'resume'; index: number };

/**
 * `advanceStage` rejected our optimistic `fromStage` guard, so another runner moved this
 * call concurrently. Re-read the row and decide — but NEVER blindly continue: we only skip
 * ahead if the DB is genuinely at or beyond the stage we were trying to reach.
 */
async function resolveStale(
  pool: Pool,
  callId: string,
  targetIndex: number,
): Promise<StaleResolution> {
  const state = await getCallState(pool, callId);
  if (!state) {
    throw new Error(`call_state row for ${callId} vanished mid-pipeline`);
  }
  const dbIndex = dbStageIndex(state.current_stage);

  if (state.status === STATUS_COMPLETED) {
    // Already complete is only valid when the DB stage is at/beyond our target. A terminal
    // status paired with an earlier or unknown stage is a real inconsistency.
    if (dbIndex >= targetIndex) return { kind: 'complete' };
    throw new Error(
      `${callId}: terminal status paired with stage '${state.current_stage}' below target`,
    );
  }

  if (state.status === STATUS_PROCESSING) {
    // A concurrent runner advanced past this point — resume from where the DB now is.
    if (dbIndex !== -1 && dbIndex >= targetIndex) return { kind: 'resume', index: dbIndex };
    throw new Error(
      `${callId}: stage moved to '${state.current_stage}' below expected target — inconsistent`,
    );
  }

  // Any other status (a hold, or something unexpected) must not be silently skipped.
  throw new Error(`${callId}: unexpected status '${state.status}' during stale-stage recovery`);
}

/**
 * Drive one call through the pipeline state machine, resuming from wherever `call_state`
 * currently sits. Each stage runs its (stub) handler, then {@link advanceStage} atomically
 * moves `current_stage` forward AND writes a `processing_log` row in one transaction.
 *
 * Idempotent by design:
 * - A completed call is a no-op (terminal guard), so a fresh BullMQ job created after
 *   `removeOnComplete` eviction won't re-run stages or duplicate log rows.
 * - On retry the loop resumes from the persisted `current_stage`; the `fromStage` optimistic
 *   guard turns a concurrent/duplicate advance into a re-verify (never a blind skip).
 *
 * Handlers must themselves be idempotent: a crash after a handler runs but before its advance
 * commits re-runs that handler on retry. Trivial for the stubs; a convention real stages inherit.
 */
export async function runPipeline(
  pool: Pool,
  callId: string,
  logger: Logger,
  handlers: StageHandlers = defaultStageHandlers,
): Promise<void> {
  const state = await getCallState(pool, callId);
  if (!state) {
    throw new Error(`call_state row for ${callId} does not exist — call was not seeded`);
  }

  // Terminal no-op guard: complete ONLY when status is terminal AND the stage is the final
  // one. Terminal + any other stage is an inconsistency, not a completed call.
  if (state.status === STATUS_COMPLETED) {
    if (state.current_stage === FINAL_STAGE) {
      logger.info({ stage: state.current_stage }, 'call already complete — no-op');
      return;
    }
    throw new Error(
      `${callId}: terminal status paired with stage '${state.current_stage}' — inconsistent`,
    );
  }

  // Terminal no-op guard for a dropped call — mirrors the completed guard. A valid
  // `skipped` row sits at a skip-stage with a non-null drop_reason; anything else is a
  // real inconsistency, not a completed drop.
  if (state.status === STATUS_SKIPPED) {
    if (SKIP_STAGES.has(state.current_stage as PipelineStage) && state.drop_reason !== null) {
      logger.info(
        { stage: state.current_stage, drop_reason: state.drop_reason },
        'call already skipped — no-op',
      );
      return;
    }
    throw new Error(
      `${callId}: skipped status paired with stage '${state.current_stage}' / drop_reason ` +
        `'${state.drop_reason ?? 'null'}' — inconsistent`,
    );
  }

  // Terminal no-op guard for a held call — mirrors the completed/skipped guards. A valid
  // `held` row sits at a known stage AND has an ACTIVE review_queue row (holdCall writes both
  // atomically). Re-enqueueing it must never re-run stages. A held row missing either
  // invariant — unknown stage, or no active review (e.g. resolved but call_state not moved
  // off `held`) — is real corruption, not a completed hold, so surface it rather than
  // silently dropping the call from the pipeline forever.
  if (state.status === STATUS_HELD) {
    const knownStage = isPipelineStage(state.current_stage);
    const hasReview = knownStage && (await hasActiveReviewForCall(pool, callId));
    if (knownStage && hasReview) {
      logger.info({ stage: state.current_stage }, 'call already held — no-op');
      return;
    }
    throw new Error(
      `${callId}: held status paired with stage '${state.current_stage}' / active review ` +
        `${String(hasReview)} — inconsistent`,
    );
  }

  // Validate the starting stage before walking, so an unknown stage can't index from -1.
  let index = dbStageIndex(state.current_stage);
  if (index === -1) {
    throw new Error(`${callId}: unknown current_stage '${state.current_stage}'`);
  }

  while (index <= LAST_INDEX) {
    const stage = PIPELINE_STAGES[index] as PipelineStage;

    const startedAt = Date.now();
    const durationMs = (): number => Date.now() - startedAt;
    logStageStart(logger, { callId, stage });

    let result: StageResult | void;
    try {
      result = await handlers[stage]({ callId, stage, logger, pool });
    } catch (cause) {
      logStageFailure(logger, { callId, stage, outcome: 'failed', durationMs: durationMs() });
      // Wrap so the worker's failed-handler knows exactly which stage failed. Fail-closed:
      // PipelineStageError never carries the raw error message.
      throw new PipelineStageError(stage, callId, cause);
    }

    // A stage asked to drop the call: skip it atomically and STOP before the next stage,
    // so a dropped call can never reach fetch-transcript.
    if (result && result.action === 'drop') {
      try {
        await skipCall(pool, {
          callId,
          atStage: stage,
          dropReason: result.reason,
          ...(result.detail !== undefined ? { logDetail: result.detail } : {}),
        });
      } catch (err) {
        if (!isStaleStageError(err)) throw err;
        // A concurrent runner won the race. Re-read: if it landed on a terminal state,
        // this is a legitimate no-op; otherwise it is a real inconsistency.
        const raced = await getCallState(pool, callId);
        if (!raced) throw new Error(`call_state row for ${callId} vanished mid-skip`);
        if (raced.status === STATUS_SKIPPED || raced.status === STATUS_COMPLETED) return;
        throw new Error(`${callId}: skip raced but status is '${raced.status}' — inconsistent`);
      }
      logStageSuccess(logger, { callId, stage, outcome: 'skipped', durationMs: durationMs() });
      return;
    }

    // A stage asked to defer: it has already scheduled its own delayed re-run (e.g. a
    // not-ready transcript retry). STOP here without advancing or failing — the call stays
    // at this stage in `processing` and resumes when the delayed job fires.
    if (result && result.action === 'defer') {
      logStageSuccess(logger, { callId, stage, outcome: 'deferred', durationMs: durationMs() });
      return;
    }

    // A stage asked to hold the call for a person: hold it atomically (status + review_queue
    // + processing_log) and STOP. Mirrors the drop path's stale-race handling.
    if (result && result.action === 'hold') {
      // A hold carrying an error_code IS a failure-model event, so its processing_log row must
      // carry the full §4 snapshot (Task 7.4). A stage may pass an explicit `failureSnapshot`
      // (with its own processing_state / diagnostics); otherwise the runner synthesizes one
      // from the catalog so EVERY error-coded hold row stays explainable after its alert is
      // gone. A hold with no error_code is a routing hold (spam, emergency review), not a
      // failure — no snapshot, mirroring the drop path.
      const holdSnapshot =
        result.failureSnapshot ??
        (result.errorCode !== undefined
          ? failureSnapshot(
              createFailure(result.errorCode, {
                processingState: 'continuing',
                context: { call_id: callId, stage },
              }),
            )
          : undefined);
      try {
        await holdCall(pool, {
          callId,
          atStage: stage,
          heldReason: result.reason,
          ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          ...(result.detail !== undefined ? { logDetail: result.detail } : {}),
          ...(holdSnapshot !== undefined ? { failureSnapshot: holdSnapshot } : {}),
        });
      } catch (err) {
        if (!isStaleStageError(err)) throw err;
        // A concurrent runner won the race. Re-read: a terminal state is a legitimate
        // no-op; anything else is a real inconsistency.
        const raced = await getCallState(pool, callId);
        if (!raced) throw new Error(`call_state row for ${callId} vanished mid-hold`);
        if (
          raced.status === STATUS_HELD ||
          raced.status === STATUS_SKIPPED ||
          raced.status === STATUS_COMPLETED
        ) {
          return;
        }
        throw new Error(`${callId}: hold raced but status is '${raced.status}' — inconsistent`);
      }
      logStageFailure(logger, {
        callId,
        stage,
        outcome: 'held',
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        durationMs: durationMs(),
      });
      return;
    }

    const isFinal = index === LAST_INDEX;
    const toStage: PipelineStage = isFinal
      ? FINAL_STAGE
      : (PIPELINE_STAGES[index + 1] as PipelineStage);
    const targetIndex = isFinal ? LAST_INDEX : index + 1;

    const continueDetail = result && result.action === 'continue' ? result.detail : undefined;

    try {
      await advanceStage(pool, {
        callId,
        fromStage: stage,
        toStage,
        ...(isFinal ? { status: STATUS_COMPLETED } : {}),
        logEntry: {
          stage,
          outcome: 'completed',
          ...(continueDetail !== undefined ? { detail: continueDetail } : {}),
        },
      });
      logStageSuccess(logger, { callId, stage, outcome: 'completed', durationMs: durationMs() });
    } catch (err) {
      if (!isStaleStageError(err)) throw err;
      const resolution = await resolveStale(pool, callId, targetIndex);
      if (resolution.kind === 'complete') return;
      index = resolution.index;
      continue;
    }

    if (isFinal) return;
    index += 1;
  }
}
