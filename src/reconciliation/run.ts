import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { checkUrlFor, httpPing, pingSuccess, requireCheckUrl } from '../heartbeat/index.js';
import type { DialpadClient, RecentCall } from '../dialpad/client/index.js';
import { DialpadError } from '../dialpad/client/index.js';
import { getCallState, seedCallStateIfAbsent } from '../db/repositories/call-state-repo.js';
import { hasDeadLetter } from '../db/repositories/dead-letter-repo.js';
import { enqueueCall, type PipelineJobData } from '../queue/pipeline-queue.js';
import { PIPELINE_STAGES, STATUS_PROCESSING } from '../pipeline/stages.js';

/** The source tag recorded on `call_state` for calls the reconciliation sweep ingested. */
export const RECONCILIATION_SOURCE = 'dialpad-reconciliation';

/** Injected time so the lookback window is deterministic in tests. */
export interface ReconciliationClock {
  now(): number;
}

export interface ReconciliationSummary {
  /** Unique calls listed from Dialpad within the widened lookback. */
  callsChecked: number;
  /** Calls not yet in the pipeline that were seeded and/or enqueued this run. */
  gapsEnqueued: number;
}

export interface ReconciliationDeps {
  config: Config;
  logger: Logger;
  /** Metadata listing ONLY — the sweep never touches the transcript endpoint. */
  client: Pick<DialpadClient, 'listRecentlyConcludedCalls'>;
  /** Whether the call is genuinely in the pipeline. False for a missing row AND for a row
   * still sitting un-advanced at the first stage in `processing` — that is seed-then-enqueue
   * failure residue (a row was written but no job ever made it to Redis), and skipping it
   * would strand the call forever. Re-enqueueing is safe: the job id is call_id-keyed, so if
   * a live job DOES exist the add collapses into it. */
  alreadyInPipeline: (callId: string) => Promise<boolean>;
  /** Seed `call_state` (insert-if-absent) and enqueue the pipeline job (idempotent). */
  ingestGap: (call: RecentCall) => Promise<void>;
  /** Fire the dead-man's-switch ping. Defaults to an HTTP GET; injectable for tests. */
  pingCheck?: (url: string) => Promise<void>;
  clock?: ReconciliationClock;
}

/**
 * Fail-fast guard for the cron entrypoint: in staging/production the reconciliation cron MUST
 * have its own dead-man's-switch URL — a silently unmonitored backstop is a broken backstop.
 * Outside those environments the ping is optional (local dev and tests simply skip it). Thin
 * wrapper over the shared {@link requireCheckUrl} so the component identity stays explicit.
 */
export function requireReconciliationCheckUrl(config: Config): void {
  requireCheckUrl(config, 'reconciliation-cron');
}

/** States that POSITIVELY mean the call has not concluded yet. Anything else — including an
 * unknown or absent state — fails open, because the state vocabulary is provisional. */
const NON_TERMINAL_CALL_STATES: ReadonlySet<string> = new Set([
  'active',
  'in_progress',
  'ringing',
  'queued',
]);

/**
 * Whether a listed call belongs in this sweep. Three-tier decision, most reliable signal
 * first:
 *  - a parseable end timestamp → in the sweep iff it concluded inside the window;
 *  - no end timestamp but a recognised in-progress state → not concluded yet, skip (the
 *    webhook fires at conclusion, and later sweeps still list it by start time);
 *  - otherwise → fail OPEN. Excluding on an absent/unknown field could silently blind the
 *    whole backstop; over-inclusion is idempotent-safe.
 */
function shouldSweepListedCall(call: RecentCall, concludedSince: number): boolean {
  if (call.endedAt !== undefined) return call.endedAt >= concludedSince;
  const state = call.state?.toLowerCase();
  if (state !== undefined && NON_TERMINAL_CALL_STATES.has(state)) return false;
  return true;
}

/**
 * One reconciliation sweep (Task 3.4): list calls concluded within the lookback window from
 * Dialpad METADATA, find any not yet in the pipeline (the webhook missed them, or a prior
 * ingest died between seeding and enqueueing), and seed + enqueue exactly those. The worker
 * does everything else (pre-filter, then transcript fetch); this never reads a transcript.
 * Runs to completion, logs ONE summary line, and pings its own external check only after
 * the whole sweep succeeded.
 *
 * Dialpad's list API filters by START time only, so the query reaches back
 * `window + max-call-duration`: a call that started before the window but concluded inside
 * it is still listed. The overshoot is harmless — anything already ingested is skipped.
 */
export async function runReconciliation(deps: ReconciliationDeps): Promise<ReconciliationSummary> {
  const { config, logger } = deps;
  const now = deps.clock?.now() ?? Date.now();
  const windowMinutes = config.RECONCILIATION_WINDOW_MINUTES;
  const since = now - (windowMinutes + config.RECONCILIATION_MAX_CALL_MINUTES) * 60_000;
  /** The window the spec actually means: calls CONCLUDED after this instant. */
  const concludedSince = now - windowMinutes * 60_000;

  const seen = new Set<string>();
  let gapsEnqueued = 0;
  let cursor: string | undefined;

  do {
    const page = await deps.client.listRecentlyConcludedCalls({
      since,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    for (const call of page.calls) {
      // Dedupe within the run: the same call repeated across pages (or an overlapping
      // window boundary) is checked once. Across runs, the pipeline check plus the
      // call_id-keyed job id keep the overlap idempotent.
      if (seen.has(call.callId)) continue;
      seen.add(call.callId);

      // The widened started_after also lists calls that concluded BEFORE the window and
      // calls still IN PROGRESS; neither is "concluded in the recent window".
      if (!shouldSweepListedCall(call, concludedSince)) continue;

      if (await deps.alreadyInPipeline(call.callId)) continue;
      await deps.ingestGap(call);
      gapsEnqueued += 1;
    }

    // A cursor that never advances would loop forever — that is a listing-contract break,
    // surfaced as api_changed rather than hidden as a hung cron.
    if (page.cursor !== undefined && page.cursor === cursor) {
      throw new DialpadError('api_changed', { endpoint: 'calls', attempts: 1 });
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  // The spec'd one-line, counts-only summary — the ONLY log line of a successful sweep.
  // Per-call detail lives in call_state/processing_log (source = dialpad-reconciliation).
  const summary: ReconciliationSummary = { callsChecked: seen.size, gapsEnqueued };
  logger.info(
    {
      calls_checked: summary.callsChecked,
      gaps_enqueued: summary.gapsEnqueued,
      window_minutes: windowMinutes,
    },
    'reconciliation sweep complete',
  );

  // Success ping — this cron's OWN check, never the worker's or retention's. A ping failure
  // is logged (sanitized, no URL) but does not fail the run: the sweep genuinely succeeded,
  // and a missed ping is exactly the signal the dead-man's switch exists to raise monitor-side.
  await pingSuccess({
    component: 'reconciliation-cron',
    url: checkUrlFor(config, 'reconciliation-cron'),
    logger,
    ping: deps.pingCheck ?? httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
  });

  return summary;
}

/**
 * Production `alreadyInPipeline` / `ingestGap` backed by Postgres + BullMQ. Mirrors the
 * webhook sink's ingest (Task 3.2) — seed `call_state` at the first pipeline stage, then
 * enqueue keyed by call_id — with this sweep's own source tag and the listed metadata
 * (direction, duration, state: non-PII) as `source_metadata`. No `raw_webhook_events` row:
 * there was no webhook.
 *
 * Failure ordering, deliberately WITHOUT a compensating delete (deletion never happens in
 * the per-call path — build plan §5): if the enqueue fails after the seed insert, the row
 * stays, but `alreadyInPipeline` reports such an un-advanced first-stage row as NOT in the
 * pipeline, so the next sweep re-enqueues it. Rescue seeding is insert-if-absent, so an
 * existing row (whoever wrote it) is never overwritten.
 */
export function createPgReconciliationIngest(deps: {
  pool: Pool;
  queue: Queue<PipelineJobData>;
  config: Config;
}): Pick<ReconciliationDeps, 'alreadyInPipeline' | 'ingestGap'> {
  const { pool, queue, config } = deps;
  return {
    async alreadyInPipeline(callId: string): Promise<boolean> {
      const row = await getCallState(pool, callId);
      if (row === undefined) return false;
      // An un-advanced `processing` row at the first stage means no worker has touched the
      // call: either its job is still queued (re-enqueue collapses by job id) or the job was
      // never created (the stranding this predicate exists to rescue).
      const pristineSeed =
        row.current_stage === PIPELINE_STAGES[0] && row.status === STATUS_PROCESSING;
      if (!pristineSeed) return true;
      // A dead-lettered call is IN the pipeline even when its row never advanced: it
      // exhausted retries and DEAD_LETTER_CREATED handed it to the manual re-drive path.
      // Automated rescue must not silently restart it.
      return hasDeadLetter(pool, callId);
    },
    async ingestGap(call: RecentCall): Promise<void> {
      await seedCallStateIfAbsent(pool, {
        callId: call.callId,
        source: RECONCILIATION_SOURCE,
        sourceMetadata: {
          ...(call.state !== undefined ? { state: call.state } : {}),
          ...(call.direction !== undefined ? { direction: call.direction } : {}),
          ...(call.duration !== undefined ? { duration: call.duration } : {}),
        },
        currentStage: PIPELINE_STAGES[0],
        status: STATUS_PROCESSING,
      });
      await enqueueCall(queue, call.callId, config);
    },
  };
}
