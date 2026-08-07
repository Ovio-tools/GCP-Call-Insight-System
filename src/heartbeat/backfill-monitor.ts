import type { Logger } from 'pino';
import { type HeartbeatComponent } from './checks.js';
import { type IntervalScheduler } from './emit.js';
import { type HeartbeatPinger, sanitizePingError } from './ping.js';

/**
 * Job-style monitor (Task 11.2, §6), first built for backfill and since shared with any bounded
 * JOB. Unlike a periodic-liveness heartbeat, a job run signals START, periodic PROGRESS while
 * alive, and exactly one terminal SUCCESS or FAIL — on FOUR DISTINCT external check URLs, so a
 * progress ping can never satisfy the terminal-success monitor (R1 #2) and a stall is a genuine
 * missing-progress alert (R1 #11).
 *
 * The owning component is a PARAMETER, not a constant: every log line here is scoped by it, so the
 * technician-note job's stall warning can never be misread as a backfill stall. Names keep the
 * `Backfill` prefix because backfill remains the reference consumer and renaming the type would
 * churn every call site for no behavioral gain.
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

/**
 * Derive the four signal URLs from a job's single check URL.
 *
 * The progress signal is `/log`. Healthchecks.io accepts `/start`, `/fail` and `/log` and rejects
 * anything else with `400 invalid url format` — the `/progress` suffix used here until 2026-08-07
 * meant EVERY progress ping from EVERY job was silently refused, so the stall signal this monitor
 * is built around never existed. `/log` records an event without changing the check's pass/fail
 * state, which is exactly the contract: only `success` may turn a check green.
 *
 * Shared rather than copied per entrypoint — two copies is how the backfill job and the
 * technician-note job came to carry the same bug. Verified against a live check, not inferred.
 */
export function deriveJobSignalUrls(base: string): BackfillSignalUrls {
  const b = base.replace(/\/+$/, '');
  return { start: `${b}/start`, progress: `${b}/log`, success: b, fail: `${b}/fail` };
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
  /** The job that owns this monitor. Scopes every log line so one job's stall warning is never
   * attributed to another's. */
  component: HeartbeatComponent;
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
function assertDistinctSignals(component: HeartbeatComponent, s: BackfillSignalUrls): void {
  const urls = [s.start, s.progress, s.success, s.fail];
  const unique = new Set(urls);
  if (unique.size !== urls.length) {
    throw new Error(
      `${component} monitor: the four signal URLs (start/progress/success/fail) must be pairwise distinct`,
    );
  }
}

export function createBackfillMonitor(deps: CreateBackfillMonitorDeps): BackfillMonitor {
  assertDistinctSignals(deps.component, deps.signals);
  const { signals, component, ping, scheduler, now, logger, progressIntervalMs, stallThresholdMs } =
    deps;

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
      logger.warn({ component }, `${component} ping failed: ${sanitizePingError(err)}`);
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
        { component, ...lastCounts },
        `${component} stalled: no progress within the stall threshold — withholding progress ping`,
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
