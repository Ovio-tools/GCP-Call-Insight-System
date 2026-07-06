import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Config } from '../config/schema.js';
import type { RecentCall } from '../dialpad/client/index.js';
import { getCallState, seedCallStateIfAbsent } from '../db/repositories/call-state-repo.js';
import { hasDeadLetter } from '../db/repositories/dead-letter-repo.js';
import { insertRunCallIfAbsent } from '../db/repositories/backfill-run-calls-repo.js';
import { enqueueCall, type PipelineJobData } from '../queue/pipeline-queue.js';
import { PIPELINE_STAGES, STATUS_PROCESSING } from '../pipeline/stages.js';

/** Source tag on `call_state` for a PRODUCTION backfill call (seed + enqueue onto the shared queue). */
export const BACKFILL_SOURCE = 'dialpad-backfill';
/** Source tag on `call_state` for a STAGING SYNTHETIC backfill call (seed + inline runPipeline). A
 * production worker refuses this tag (worker defense-in-depth, R4 #1), so a synthetic job can never
 * be processed by the real fleet even if it somehow reached the shared queue. */
export const BACKFILL_SYNTHETIC_SOURCE = 'dialpad-backfill-synthetic';

/**
 * The two operations the backfill sweep needs per listed in-window call — the SAME shape as the
 * reconciliation sweep's ingest, split by mode (R5 #1). Both track every processed/rescued call in
 * `backfill_run_calls` so the drain phase awaits it (including a rescued pre-existing seed, R2 #1).
 */
export interface BackfillIngest {
  /** Whether the call is genuinely progressing/terminal. False for a missing row AND for a pristine
   * un-advanced first-stage `processing` seed (seed-then-enqueue residue to RESCUE) — unless it is
   * dead-lettered (belongs to the manual re-drive path). Mirrors reconciliation exactly. */
  alreadyInPipeline: (callId: string) => Promise<boolean>;
  /** Seed `call_state` (insert-if-absent, mode-tagged), track in `backfill_run_calls`, then process
   * via the mode's strategy (production enqueue / staging inline runPipeline). */
  ingestGap: (call: RecentCall) => Promise<void>;
}

/** Non-PII listed metadata recorded as `source_metadata` (mirrors reconciliation). */
function sourceMetadata(call: RecentCall): Record<string, string | number> {
  return {
    ...(call.state !== undefined ? { state: call.state } : {}),
    ...(call.direction !== undefined ? { direction: call.direction } : {}),
    ...(call.duration !== undefined ? { duration: call.duration } : {}),
  };
}

/** Shared pipeline-membership check (identical to reconciliation's rescue predicate). */
async function backfillAlreadyInPipeline(pool: Pool, callId: string): Promise<boolean> {
  const row = await getCallState(pool, callId);
  if (row === undefined) return false;
  const pristineSeed = row.current_stage === PIPELINE_STAGES[0] && row.status === STATUS_PROCESSING;
  if (!pristineSeed) return true;
  return hasDeadLetter(pool, callId);
}

/**
 * PRODUCTION ingest (R5 #1): seed with {@link BACKFILL_SOURCE}, track, then ENQUEUE onto the shared
 * pipeline queue. The worker fleet runs the full `runPipeline` (redaction fail-closed impossible to
 * bypass); the drain phase awaits terminal state. Track BEFORE enqueue so an interruption between
 * the two leaves a tracked, pristine seed that a resume re-enqueues and the drain still awaits.
 */
export function createPgBackfillQueueIngest(deps: {
  pool: Pool;
  queue: Queue<PipelineJobData>;
  config: Config;
  runId: string;
}): BackfillIngest {
  const { pool, queue, config, runId } = deps;
  return {
    alreadyInPipeline: (callId) => backfillAlreadyInPipeline(pool, callId),
    async ingestGap(call: RecentCall): Promise<void> {
      await seedCallStateIfAbsent(pool, {
        callId: call.callId,
        source: BACKFILL_SOURCE,
        sourceMetadata: sourceMetadata(call),
        currentStage: PIPELINE_STAGES[0],
        status: STATUS_PROCESSING,
      });
      await insertRunCallIfAbsent(pool, runId, call.callId);
      await enqueueCall(queue, call.callId, config);
    },
  };
}

/**
 * STAGING SYNTHETIC ingest (R5 #1): seed with {@link BACKFILL_SYNTHETIC_SOURCE}, track, then run the
 * call INLINE via `runCall` (a fixture-backed `runPipeline`). Takes NO `Queue` at all, so the
 * synthetic path STRUCTURALLY cannot enqueue to the shared worker queue. Each call reaches terminal
 * synchronously, so the drain is effectively immediate.
 */
export function createPgBackfillInlineIngest(deps: {
  pool: Pool;
  runId: string;
  /** In-process pipeline run for one call (the entrypoint binds pool/logger/fixture-backed handlers). */
  runCall: (callId: string) => Promise<void>;
}): BackfillIngest {
  const { pool, runId, runCall } = deps;
  return {
    alreadyInPipeline: (callId) => backfillAlreadyInPipeline(pool, callId),
    async ingestGap(call: RecentCall): Promise<void> {
      await seedCallStateIfAbsent(pool, {
        callId: call.callId,
        source: BACKFILL_SYNTHETIC_SOURCE,
        sourceMetadata: sourceMetadata(call),
        currentStage: PIPELINE_STAGES[0],
        status: STATUS_PROCESSING,
      });
      await insertRunCallIfAbsent(pool, runId, call.callId);
      await runCall(call.callId);
    },
  };
}
