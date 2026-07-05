import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import {
  checkUrlFor,
  pingSuccess,
  requireCheckUrl,
  sanitizePingError,
  type HeartbeatPinger,
} from '../heartbeat/index.js';
import type { ScanResult } from '../review-queue/scan.js';
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
  /**
   * Best-effort in-DB liveness mirror (Task 7.3): recorded on a fully-successful sweep for the
   * status surface, INDEPENDENTLY of the external ping. A failure here is sanitized-logged and
   * NEVER skips the ping nor fails the run. Injected by the cron entrypoint (which holds the
   * pool); absent in tests/dev.
   */
  heartbeat?: (summary: ReconciliationSummary) => Promise<void>;
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
 * Runs to completion and logs ONE summary line. It does NOT ping: the external dead-man's-
 * switch ping is owned by the cron entrypoint (`runReconciliationCron`), which fires it only
 * when BOTH the sweep AND the SLA-breach scan succeeded (Task 6.1). A sweep failure rejects,
 * so the entrypoint withholds the ping.
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

  // Best-effort in-DB liveness mirror for the status surface, fully wrapped so a DB-write
  // failure never fails the sweep: the external check (fired by the entrypoint on combined
  // success) stays the authoritative alert source. Counts only, no PII.
  if (deps.heartbeat !== undefined) {
    try {
      await deps.heartbeat(summary);
    } catch (err) {
      logger.warn(
        { component: 'reconciliation-cron' },
        `heartbeat DB mirror failed: ${sanitizePingError(err)}`,
      );
    }
  }

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

export interface ReconciliationCronDeps {
  config: Config;
  logger: Logger;
  /** The Dialpad metadata sweep. Rejects on a Dialpad/enqueue failure. */
  runSweep: () => Promise<unknown>;
  /** The review-SLA-breach scan; its `failed`/`lockedSkipped` tally marks incompleteness. */
  runScan: () => Promise<ScanResult>;
  /** Drain the reprocess-request outbox (Task 6.2). Optional; its `failed` tally marks
   * incompleteness exactly like the scan, so an incomplete drain withholds the ping. Runs AFTER
   * the scan and independently of the sweep. */
  runDrain?: () => Promise<{ failed: number }>;
  /** Mine resolved review decisions into the labeled corpus (Task 6.3). Optional health-gated duty:
   * `clean_transcripts` is purgeable, so label capture must beat its retention window — running it
   * here (every 15 min) captures a correction within minutes. Its `failed` tally (an operational
   * failure) or a throw marks incompleteness, so BROKEN label capture withholds the ping; the
   * expected per-candidate outcomes do not. Runs AFTER the drain, independently of the sweep. */
  runLabelSync?: () => Promise<{ failed: number }>;
  /** External dead-man's-switch ping. */
  ping: HeartbeatPinger;
  /** Handle a sweep failure (map a typed Dialpad failure → deduped alert, log). Best-effort —
   * MUST NOT throw; the ping is withheld by the combined-health gate regardless. */
  onSweepError: (err: unknown) => Promise<void>;
}

/**
 * Reconciliation-cron orchestration (Task 6.1). Two INDEPENDENT duties — the Dialpad metadata
 * sweep and the review-SLA-breach scan — each attempted so one failing never skips the other
 * (overdue held calls must still escalate/alert even when reconciliation is broken). The scan
 * runs REGARDLESS of the sweep outcome. The external ping (now a COMBINED health signal) fires
 * ONLY when BOTH duties fully succeed; otherwise this throws so the process exits non-zero and
 * the missed check IS the alert for whichever duty failed. Consistent with CLAUDE.md's "crons
 * ping only after a fully successful run."
 *
 * The sweep + scan are injected (not called directly) so the entrypoint keeps the Dialpad-alert
 * mapping and DB wiring while this stays a pure, unit-testable orchestrator.
 */
export async function runReconciliationCron(deps: ReconciliationCronDeps): Promise<void> {
  const { config, logger } = deps;

  let sweepOk = true;
  try {
    await deps.runSweep();
  } catch (err) {
    sweepOk = false;
    // The handler SHOULD be best-effort, but wrap it so a throwing/buggy handler can never skip
    // the SLA scan below — the scan must run regardless of the sweep outcome.
    try {
      await deps.onSweepError(err);
    } catch (handlerErr) {
      logger.error(
        { component: 'reconciliation-cron' },
        `sweep error handler failed: ${handlerErr instanceof Error ? handlerErr.name : typeof handlerErr}`,
      );
    }
  }

  // The scan is attempted whether or not the sweep succeeded. Healthy rows are escalated+alerted
  // before it returns its tally, so one bad row only withholds the heartbeat.
  let scanIncomplete = false;
  try {
    const { escalated, failed, lockedSkipped } = await deps.runScan();
    scanIncomplete = failed > 0 || lockedSkipped > 0;
    if (scanIncomplete) {
      logger.warn(
        { component: 'reconciliation-cron', escalated, failed, locked_skipped: lockedSkipped },
        'stalled-review scan incomplete — withholding heartbeat',
      );
    }
  } catch (err) {
    scanIncomplete = true;
    logger.error(
      { component: 'reconciliation-cron' },
      `stalled-review scan failed: ${err instanceof Error ? err.name : typeof err}`,
    );
  }

  // The reprocess-outbox drain (Task 6.2): runs after the scan, independently of the sweep. An
  // incomplete drain (an enqueue failure left a row pending) or a throwing drain withholds the
  // ping so the missed check surfaces the stranded reprocess. Absent in tests/older callers.
  let drainIncomplete = false;
  if (deps.runDrain) {
    try {
      const { failed } = await deps.runDrain();
      drainIncomplete = failed > 0;
      if (drainIncomplete) {
        logger.warn(
          { component: 'reconciliation-cron', failed },
          'reprocess drain incomplete — withholding heartbeat',
        );
      }
    } catch (err) {
      drainIncomplete = true;
      logger.error(
        { component: 'reconciliation-cron' },
        `reprocess drain failed: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }

  // The label-sync duty (Task 6.3): mines resolved review decisions into the labeled corpus. An
  // operational failure (nonzero `failed`) or a throw withholds the ping so broken label capture
  // alerts — but the expected per-candidate outcomes (accepted/pii/schema/missing_clean/already-
  // present) do NOT. Runs after the drain, independently of the sweep. Absent in older callers.
  let labelSyncIncomplete = false;
  if (deps.runLabelSync) {
    try {
      const { failed } = await deps.runLabelSync();
      labelSyncIncomplete = failed > 0;
      if (labelSyncIncomplete) {
        logger.warn(
          { component: 'reconciliation-cron', failed },
          'label sync incomplete — withholding heartbeat',
        );
      }
    } catch (err) {
      labelSyncIncomplete = true;
      logger.error(
        { component: 'reconciliation-cron' },
        `label sync failed: ${err instanceof Error ? err.name : typeof err}`,
      );
    }
  }

  if (sweepOk && !scanIncomplete && !drainIncomplete && !labelSyncIncomplete) {
    // The combined ping: this cron's OWN check, only after ALL duties succeeded. A ping failure
    // is logged (sanitized, no URL) but does not fail the run — the missed check is the alarm.
    await pingSuccess({
      component: 'reconciliation-cron',
      url: checkUrlFor(config, 'reconciliation-cron'),
      logger,
      ping: deps.ping,
    });
    return;
  }
  throw new Error('reconciliation-cron: a duty failed — external ping withheld');
}
