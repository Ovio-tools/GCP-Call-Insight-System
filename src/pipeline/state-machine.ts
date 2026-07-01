import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { DalError, DAL_STALE_STAGE } from '../db/index.js';
import { advanceStage, getCallState } from '../db/repositories/call-state-repo.js';
import { PipelineStageError } from './errors.js';
import {
  FINAL_STAGE,
  PIPELINE_STAGES,
  STATUS_COMPLETED,
  STATUS_PROCESSING,
  defaultStageHandlers,
  type PipelineStage,
  type StageHandlers,
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

  // Validate the starting stage before walking, so an unknown stage can't index from -1.
  let index = dbStageIndex(state.current_stage);
  if (index === -1) {
    throw new Error(`${callId}: unknown current_stage '${state.current_stage}'`);
  }

  while (index <= LAST_INDEX) {
    const stage = PIPELINE_STAGES[index] as PipelineStage;

    try {
      await handlers[stage]({ callId, stage, logger, pool });
    } catch (cause) {
      // Wrap so the worker's failed-handler knows exactly which stage failed. Fail-closed:
      // PipelineStageError never carries the raw error message.
      throw new PipelineStageError(stage, callId, cause);
    }

    const isFinal = index === LAST_INDEX;
    const toStage: PipelineStage = isFinal
      ? FINAL_STAGE
      : (PIPELINE_STAGES[index + 1] as PipelineStage);
    const targetIndex = isFinal ? LAST_INDEX : index + 1;

    try {
      await advanceStage(pool, {
        callId,
        fromStage: stage,
        toStage,
        ...(isFinal ? { status: STATUS_COMPLETED } : {}),
        logEntry: { stage, outcome: 'completed' },
      });
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
