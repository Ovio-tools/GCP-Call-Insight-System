import type { Logger } from 'pino';
import { type IntervalScheduler } from './emit.js';
import { type HeartbeatPinger, sanitizePingError } from './ping.js';

/**
 * Job-style backfill monitor (Task 11.2, §6). Unlike a periodic-liveness heartbeat, a backfill run
 * is a bounded JOB: it signals START, periodic PROGRESS while alive, and exactly one terminal
 * SUCCESS or FAIL — on FOUR DISTINCT external check URLs, so a progress ping can never satisfy the
 * terminal-success monitor (R1 #2) and a stall is a genuine missing-progress alert (R1 #11).
 *
 * Layered on the shared {@link HeartbeatPinger} + {@link sanitizePingError}, so the check URL and
 * any secret never leak into a log line.
 */

/** The four derived signal URLs. The entrypoint derives them from `BACKFILL_CHECK_URL`; they are
 * validated pairwise-distinct at construction (a collision would let one signal mask another). */
export interface BackfillSignalUrls {
  start: string;
  progress: string;
  success: string;
  fail: string;
}

/** Progress counters, carried for the sanitized progress/stall log line (never PII). */
export type BackfillProgressCounts = Record<string, number>;

export interface BackfillMonitor {
  /** One `start` ping (AWAITED so it lands before the run body runs); arm the progress interval.
   * Idempotent-safe: call once at run start. */
  start(): Promise<void>;
  /** Refresh the stall clock + counts on any terminal-count movement. */
  recordProgress(counts: BackfillProgressCounts): void;
  /** Terminal success: one `success` ping, stop the interval. AWAITED so the terminal signal is not
   * lost if the caller exits right after. Fires at most once. */
  success(): Promise<void>;
  /** Terminal failure: one `fail` ping, stop the interval. AWAITED so the terminal signal is not
   * lost to a `process.exit(1)` on the failure path. Fires at most once. */
  fail(): Promise<void>;
  /** Stop the interval without a terminal ping (e.g. an idle monitor never started). */
  stop(): void;
}

export interface CreateBackfillMonitorDeps {
  signals: BackfillSignalUrls;
  ping: HeartbeatPinger;
  scheduler: IntervalScheduler;
  now: () => number;
  logger: Logger;
  /** Cadence (ms) at which the interval fires; a progress ping is sent on each fire while within
   * the stall threshold. */
  progressIntervalMs: number;
  /** Max ms without terminal progress before progress pings are WITHHELD so the external monitor's
   * missing-progress window fires the stall alert. */
  stallThresholdMs: number;
}

/** Throw if any two of the four signal URLs collide — enforced BEFORE any ping (R2 #5). */
function assertDistinctSignals(s: BackfillSignalUrls): void {
  const urls = [s.start, s.progress, s.success, s.fail];
  const unique = new Set(urls);
  if (unique.size !== urls.length) {
    throw new Error(
      'backfill monitor: the four signal URLs (start/progress/success/fail) must be pairwise distinct',
    );
  }
}

export function createBackfillMonitor(deps: CreateBackfillMonitorDeps): BackfillMonitor {
  assertDistinctSignals(deps.signals);
  const { signals, ping, scheduler, now, logger, progressIntervalMs, stallThresholdMs } = deps;

  let handle: unknown;
  let lastProgressAt = 0;
  let terminated = false;
  let started = false;
  let lastCounts: BackfillProgressCounts = {};

  /** Send a ping and AWAIT it; a transport failure is sanitized-logged, never thrown (the missed
   * external check is the authoritative alarm). Terminal signals await this so the ping is not lost
   * to a `process.exit(1)` on the failure path. */
  const runPing = async (url: string): Promise<void> => {
    try {
      await ping(url);
    } catch (err) {
      logger.warn({ component: 'backfill' }, `backfill ping failed: ${sanitizePingError(err)}`);
    }
  };

  const tick = (): void => {
    if (terminated) return;
    if (now() - lastProgressAt <= stallThresholdMs) {
      // Periodic progress ping is fire-and-forget: a dropped one is harmless (the next tick or the
      // stall window covers it), and the interval callback cannot await.
      void runPing(signals.progress);
    } else {
      // Withhold the progress ping so the external monitor's missing-progress window fires. Log
      // sanitized context (counts only, no PII, no URL).
      logger.warn(
        { component: 'backfill', ...lastCounts },
        'backfill stalled: no terminal progress within the stall threshold — withholding progress ping',
      );
    }
  };

  const stopInterval = (): void => {
    if (handle !== undefined) {
      scheduler.clear(handle);
      handle = undefined;
    }
  };

  return {
    async start(): Promise<void> {
      if (started || terminated) return;
      started = true;
      lastProgressAt = now();
      // Arm the interval synchronously, then await the start ping so it lands before the run body.
      handle = scheduler.set(() => tick(), progressIntervalMs);
      await runPing(signals.start);
    },
    recordProgress(counts: BackfillProgressCounts): void {
      lastProgressAt = now();
      lastCounts = counts;
    },
    async success(): Promise<void> {
      if (terminated) return;
      terminated = true;
      stopInterval();
      await runPing(signals.success);
    },
    async fail(): Promise<void> {
      if (terminated) return;
      terminated = true;
      stopInterval();
      await runPing(signals.fail);
    },
    stop(): void {
      terminated = true;
      stopInterval();
    },
  };
}
