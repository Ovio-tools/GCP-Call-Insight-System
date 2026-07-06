import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import { DialpadError } from '../dialpad/client/index.js';
import {
  findResumableRun,
  getRun,
  resetRun,
  startRun,
  updateCheckpoint,
} from '../db/repositories/backfill-runs-repo.js';
import { countRunCalls } from '../db/repositories/backfill-run-calls-repo.js';
import type { BackfillRunRow } from '../db/schemas/backfill-runs.js';
import { RESUMABLE_BACKFILL_RUN_STATUSES } from '../db/schemas/backfill-runs.js';
import type { BackfillMonitor } from '../heartbeat/index.js';
import { BackfillError } from './errors.js';
import type { BackfillIngest } from './ingest.js';
import {
  advanceWatermark,
  decodeCheckpoint,
  encodeCheckpoint,
  pageStartedAtFailure,
  shouldSkip,
  type BackfillCheckpoint,
} from './checkpoint.js';
import { callMembership, computeSince, type WindowBounds } from './window.js';
import { countNonTerminalTrackedCalls } from './terminal.js';

/** Session-level advisory lock key for the backfill runner. DISTINCT from retention's 8_100_001 so
 * a backfill and a retention purge never contend, only backfills-vs-backfills. Held for the ENTIRE
 * run (sweep + drain) on a dedicated client. */
export const BACKFILL_ADVISORY_LOCK_KEY = 8_100_002;

export interface RunBackfillResult {
  runId: string;
  status: 'completed';
  /** Calls seeded/rescued+processed this run. */
  seededTotal: number;
  /** Unique calls listed this run. */
  callsSeen: number;
  /** Tracked calls that reached terminal by the time the drain finished. */
  terminalCount: number;
}

export interface RunBackfillDeps {
  pool: Pool;
  config: Config;
  logger: Logger;
  /** The window `[from, to]` (epoch ms) — membership is by CONCLUSION time (§2). */
  window: WindowBounds;
  /** Metadata listing ONLY — the sweep never reads a transcript. */
  client: Pick<DialpadClient, 'listRecentlyConcludedCalls'>;
  /** Mode-split ingest FACTORY (production enqueue / staging inline). Called with the resolved run
   * id (known only after resume/create/restart) so tracking rows carry it. */
  ingestFor: (runId: string) => BackfillIngest;
  /** The four-signal job monitor (§6). */
  monitor: BackfillMonitor;
  /** `--resume <runId>`: continue that run from its checkpoint. */
  resume?: string;
  /** `--restart-from-scratch`: REQUIRES `resume`; reuse that row, clear checkpoint + tracking. */
  restartFromScratch?: boolean;
  /** Record the ONE `BACKFILL_CHECKPOINT_FAILED` alert on a checkpoint-write failure (best-effort). */
  emitCheckpointAlert: (context: Record<string, string>) => Promise<void>;
  /** Persist the checkpoint JSON (default: updateCheckpoint). Injectable so tests force a failure. */
  saveCheckpoint?: (runId: string, json: string) => Promise<void>;
  /** Persist a status change (default: updateCheckpoint). Injectable for tests. */
  setRunStatus?: (runId: string, status: string) => Promise<void>;
  /** Drain-poll delay (default: config.BACKFILL_DRAIN_POLL_MS via setTimeout). */
  drainSleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isResumable(status: string): boolean {
  return (RESUMABLE_BACKFILL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Refuse a `--resume <id>` whose stored window does not match the requested `--from`/`--to`, so a
 * run's checkpoint + tracking are never advanced against a DIFFERENT historical window. Checked
 * before any reset/checkpoint decode/ingest (and before the start ping — resolveRun runs first). */
function assertResumeWindowMatches(
  existing: BackfillRunRow,
  windowRange: { windowStart: Date; windowEnd: Date },
  runId: string,
): void {
  if (
    existing.window_start.getTime() !== windowRange.windowStart.getTime() ||
    existing.window_end.getTime() !== windowRange.windowEnd.getTime()
  ) {
    throw new BackfillError(
      'resume_window_mismatch',
      `--resume ${runId} names a run whose window does not match the requested --from/--to`,
      { job_id: runId },
    );
  }
}

/**
 * The historical backfill orchestrator (Task 11.2). Holds a session advisory lock across the whole
 * run, resolves resume/create/restart, sweeps the conclusion-time window (seed + track + process via
 * the mode's ingest, checkpointing each fully-ingested page), then drains until every tracked call
 * is terminal — only then a terminal success ping. A checkpoint-write failure stops cleanly at the
 * last good checkpoint with one `BACKFILL_CHECKPOINT_FAILED` alert (resumable).
 */
export async function runBackfill(deps: RunBackfillDeps): Promise<RunBackfillResult> {
  const { pool, config, logger, window, monitor } = deps;
  const drainSleep = deps.drainSleep ?? realSleep;
  const windowRange = {
    windowStart: new Date(window.fromMs),
    windowEnd: new Date(window.toMs),
  };

  const saveCheckpoint =
    deps.saveCheckpoint ??
    (async (runId: string, json: string): Promise<void> => {
      await updateCheckpoint(pool, runId, { lastCheckpoint: json });
    });
  const setRunStatus =
    deps.setRunStatus ??
    (async (runId: string, status: string): Promise<void> => {
      await updateCheckpoint(pool, runId, { status });
    });

  // Acquire the session advisory lock on a DEDICATED client, held for the entire run. A second run
  // gets `already_running` and returns WITHOUT a start ping.
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const res = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      BACKFILL_ADVISORY_LOCK_KEY,
    ]);
    locked = res.rows[0]?.ok === true;
    if (!locked) {
      throw new BackfillError('already_running', 'another backfill run holds the advisory lock');
    }

    // Resolve resume / create / restart BEFORE the start ping.
    const { run, checkpoint } = await resolveRun(deps, windowRange);
    // The ingest is bound to the resolved run id (tracking rows carry it).
    const ingest = deps.ingestFor(run.id);

    // Checkpoint-write failure path (R1 #5): emit the alert, best-effort mark failed (separate
    // write), fail the monitor, throw checkpoint_failed. Wrapped so BOTH sweep + drain use it.
    const writeCheckpoint = async (cp: BackfillCheckpoint): Promise<void> => {
      try {
        await saveCheckpoint(run.id, encodeCheckpoint(cp));
      } catch (err) {
        const ctx = {
          component: 'backfill',
          environment: config.NODE_ENV,
          job_id: run.id,
          phase: cp.phase,
        };
        await deps.emitCheckpointAlert(ctx);
        await setRunStatus(run.id, 'failed').catch(() => undefined);
        // Await the terminal fail ping so it lands before the CLI's process.exit(1).
        await monitor.fail();
        logger.error(
          { component: 'backfill', job_id: run.id, phase: cp.phase },
          `backfill checkpoint write failed (${err instanceof Error ? err.name : typeof err})`,
        );
        throw new BackfillError(
          'checkpoint_failed',
          'checkpoint write failed — stopping at last good checkpoint',
          {
            job_id: run.id,
          },
        );
      }
    };

    // Await the start ping so the job-style monitor records the run beginning before any work.
    await monitor.start();

    try {
      const swept = await sweep({ deps, ingest, checkpoint, writeCheckpoint });
      // Reconcile the seeded count with what is actually tracked before drain. On a resume after a
      // checkpoint-write failure the checkpoint may be null while calls were already tracked, so the
      // sweep's per-run `seededTotal` can undercount; the tracking table is the source of truth for
      // how many calls this run's drain must await, keeping counters ≥ terminalCount.
      swept.seededTotal = Math.max(swept.seededTotal, await countRunCalls(pool, run.id));
      const terminalCount = await drain({
        deps,
        run,
        swept,
        drainSleep,
        writeCheckpoint,
      });
      await setRunStatus(run.id, 'completed');
      // Await the terminal success ping so it is not lost if the caller exits immediately after.
      await monitor.success();
      logger.info(
        {
          component: 'backfill',
          job_id: run.id,
          calls_seen: swept.callsSeen,
          seeded_total: swept.seededTotal,
          terminal_count: terminalCount,
        },
        'backfill run complete',
      );
      return {
        runId: run.id,
        status: 'completed',
        seededTotal: swept.seededTotal,
        callsSeen: swept.callsSeen,
        terminalCount,
      };
    } catch (err) {
      // A checkpoint_failed already alerted + failed the monitor + marked failed. Any OTHER error
      // (Dialpad, missing_started_at, membership) still marks the run failed + fails the monitor
      // (both idempotent), so the missed success ping is the alert.
      if (!(err instanceof BackfillError && err.reason === 'checkpoint_failed')) {
        await setRunStatus(run.id, 'failed').catch(() => undefined);
        // Await the terminal fail ping so it lands before the CLI's process.exit(1).
        await monitor.fail();
      }
      throw err;
    }
  } finally {
    if (locked) {
      await lockClient
        .query('SELECT pg_advisory_unlock($1)', [BACKFILL_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

/** Determine which run this invocation operates on (§4). */
async function resolveRun(
  deps: RunBackfillDeps,
  windowRange: { windowStart: Date; windowEnd: Date },
): Promise<{ run: BackfillRunRow; checkpoint: BackfillCheckpoint | undefined }> {
  const { pool } = deps;

  if (deps.restartFromScratch === true) {
    if (deps.resume === undefined) {
      throw new BackfillError(
        'invalid_window',
        '--restart-from-scratch requires --resume <runId> (it reuses that run row)',
      );
    }
    const existing = await getRun(pool, deps.resume);
    if (existing === undefined || !isResumable(existing.status)) {
      throw new BackfillError(
        'resumable_run_exists',
        `--resume ${deps.resume} is not a resumable run (unknown or completed)`,
        { job_id: deps.resume },
      );
    }
    // Refuse a window mismatch BEFORE the reset, so a wrong window never clears a run's tracking.
    assertResumeWindowMatches(existing, windowRange, deps.resume);
    const reset = await resetRun(pool, deps.resume);
    if (reset === undefined) {
      throw new BackfillError('resumable_run_exists', `run ${deps.resume} vanished during reset`, {
        job_id: deps.resume,
      });
    }
    // Restart from the top: no checkpoint.
    return { run: reset, checkpoint: undefined };
  }

  if (deps.resume !== undefined) {
    const existing = await getRun(pool, deps.resume);
    if (existing === undefined || !isResumable(existing.status)) {
      throw new BackfillError(
        'resumable_run_exists',
        `--resume ${deps.resume} is not a resumable run (unknown or completed)`,
        { job_id: deps.resume },
      );
    }
    // Refuse a window mismatch BEFORE decoding the checkpoint or touching the run.
    assertResumeWindowMatches(existing, windowRange, deps.resume);
    // Ensure it is `running` while we work (interrupted/failed → running).
    const checkpoint = decodeCheckpoint(existing.last_checkpoint);
    if (existing.status !== 'running') {
      await updateCheckpoint(pool, existing.id, { status: 'running' });
    }
    return { run: existing, checkpoint };
  }

  // No resume/restart: refuse to auto-create a second run if a resumable one exists.
  const resumable = await findResumableRun(pool, windowRange);
  if (resumable !== undefined) {
    throw new BackfillError(
      'resumable_run_exists',
      `a resumable run (${resumable.id}) exists for this window — pass --resume <id> or --restart-from-scratch`,
      { job_id: resumable.id },
    );
  }
  const run = await startRun(pool, { ...windowRange, status: 'running' });
  return { run, checkpoint: undefined };
}

interface SweptState {
  watermark: number | null;
  callsSeen: number;
  seededTotal: number;
}

/** Phase 1 — page the window, ingest each in-window gap, checkpoint each fully-ingested page. */
async function sweep(args: {
  deps: RunBackfillDeps;
  ingest: BackfillIngest;
  checkpoint: BackfillCheckpoint | undefined;
  writeCheckpoint: (cp: BackfillCheckpoint) => Promise<void>;
}): Promise<SweptState> {
  const { deps, ingest, checkpoint, writeCheckpoint } = args;
  const { config, client, window } = deps;
  const since = computeSince(window.fromMs, config.BACKFILL_MAX_CALL_MINUTES);

  let watermark = checkpoint?.watermarkStartedAtMs ?? null;
  let seededTotal = checkpoint?.seededTotal ?? 0;
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await client.listRecentlyConcludedCalls({
      since,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    // Fail-closed: a page with ANY item lacking a parseable startedAt stops BEFORE ingest or
    // checkpoint, so the watermark never advances over an unorderable page (R2 #3).
    const badId = pageStartedAtFailure(page.calls);
    if (badId !== undefined) {
      throw new BackfillError(
        'missing_started_at',
        'listed call has no parseable startedAt — refusing to checkpoint over an unorderable page',
        { call_id: badId },
      );
    }

    for (const call of page.calls) {
      if (seen.has(call.callId)) continue;
      seen.add(call.callId);
      // Resume skip: strictly newer than the watermark is already ingested (R1 #3).
      if (shouldSkip(call.startedAt as number, watermark)) continue;
      if (callMembership(call, window) === 'skip') continue;
      if (await ingest.alreadyInPipeline(call.callId)) continue;
      await ingest.ingestGap(call);
      seededTotal += 1;
    }

    // Advance the watermark to the page's oldest startedAt (the whole page had valid startedAt).
    if (page.calls.length > 0) {
      watermark = advanceWatermark(
        watermark,
        page.calls.map((c) => c.startedAt as number),
      );
    }

    await writeCheckpoint({
      v: 1,
      phase: 'sweep',
      watermarkStartedAtMs: watermark,
      callsSeen: seen.size,
      seededTotal,
      terminalCount: 0,
    });

    // A cursor that never advances is a listing-contract break, not a hung sweep.
    if (page.cursor !== undefined && page.cursor === cursor) {
      throw new DialpadError('api_changed', { endpoint: 'calls', attempts: 1 });
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  return { watermark, callsSeen: seen.size, seededTotal };
}

/** Phase 2 — poll until every tracked call is terminal (or dead-lettered), then success. */
async function drain(args: {
  deps: RunBackfillDeps;
  run: BackfillRunRow;
  swept: SweptState;
  drainSleep: (ms: number) => Promise<void>;
  writeCheckpoint: (cp: BackfillCheckpoint) => Promise<void>;
}): Promise<number> {
  const { deps, run, swept, drainSleep, writeCheckpoint } = args;
  const { pool, config, monitor } = deps;

  let lastTerminal = -1;
  for (;;) {
    const total = await countRunCalls(pool, run.id);
    const nonTerminal = await countNonTerminalTrackedCalls(pool, run.id);
    const terminalCount = total - nonTerminal;

    // Record progress ONLY on a real terminal-count increase, so a genuinely stalled drain stops
    // refreshing the monitor's stall clock and the missing-progress alert fires.
    if (terminalCount > lastTerminal) {
      monitor.recordProgress({ terminalCount, nonTerminal, seededTotal: swept.seededTotal });
      lastTerminal = terminalCount;
    }

    await writeCheckpoint({
      v: 1,
      phase: 'drain',
      watermarkStartedAtMs: swept.watermark,
      callsSeen: swept.callsSeen,
      seededTotal: swept.seededTotal,
      terminalCount,
    });

    if (nonTerminal === 0) return terminalCount;
    await drainSleep(config.BACKFILL_DRAIN_POLL_MS);
  }
}
