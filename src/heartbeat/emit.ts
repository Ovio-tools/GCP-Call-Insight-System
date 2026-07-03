import type { Logger } from 'pino';
import type { HeartbeatComponent } from './checks.js';
import { type HeartbeatPinger, sanitizePingError } from './ping.js';

/**
 * Cron success-only ping (Task 7.1). Call this ONLY after a run has fully succeeded — never
 * on failure, early exit, or throw, because the missed external check IS the alert. Skips
 * silently when the component has no configured URL (dev/test). Never throws: a transport
 * failure is logged as sanitized operational context (component + coarse reason only, never
 * the URL/secrets), because the authoritative alarm lives on the external monitor.
 */
export async function pingSuccess(deps: {
  component: HeartbeatComponent;
  url: string | undefined;
  logger: Logger;
  ping: HeartbeatPinger;
}): Promise<void> {
  if (deps.url === undefined) return;
  try {
    await deps.ping(deps.url);
  } catch (err) {
    deps.logger.warn(
      { component: deps.component },
      `external check ping failed: ${sanitizePingError(err)}`,
    );
  }
}

/** Minimal interval surface, injectable so tests drive beats without real timers. */
export interface IntervalScheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface LivenessHeartbeat {
  /** Run one beat now (health-gate, then ping). Exposed so tests drive it deterministically
   * and the caller can beat once immediately after boot if desired. */
  beat(): Promise<void>;
  /** Stop the scheduled interval (call on shutdown, before closing dependencies). */
  stop(): void;
}

/**
 * Worker liveness heartbeat (Task 7.1). On each interval it confirms dependencies are healthy
 * and then pings THIS component's OWN check URL. It represents liveness, not throughput: an
 * idle-but-healthy worker still beats. A health probe that reports false or throws skips the
 * beat, so the missed external check alerts — a limping worker that can no longer reach Redis
 * stops looking alive. Bound to exactly one URL at construction, so it can never ping a cron's
 * check.
 */
export function startLivenessHeartbeat(deps: {
  component: HeartbeatComponent;
  url: string;
  intervalMs: number;
  logger: Logger;
  ping: HeartbeatPinger;
  /** Dependency probe (e.g. the queue's Redis ping). Absent => always considered healthy. */
  isHealthy?: () => Promise<boolean> | boolean;
  /**
   * Best-effort in-DB liveness mirror (Task 7.3): when healthy, also record a heartbeat row for
   * the status surface. Run INDEPENDENTLY of the external ping — the ping is the authoritative
   * signal and must not be gated on this DB write, so the mirror runs after the ping and any
   * mirror failure is swallowed here (defense-in-depth; the closure itself should also be safe).
   */
  mirror?: () => Promise<void>;
  scheduler?: IntervalScheduler;
}): LivenessHeartbeat {
  const scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;

  const beat = async (): Promise<void> => {
    let healthy = true;
    if (deps.isHealthy !== undefined) {
      try {
        healthy = await deps.isHealthy();
      } catch {
        healthy = false;
      }
    }
    if (!healthy) {
      deps.logger.warn({ component: deps.component }, 'heartbeat skipped: dependencies unhealthy');
      return;
    }
    // The external ping is the authoritative liveness signal — attempt it FIRST, and never let
    // the in-DB mirror gate it.
    try {
      await deps.ping(deps.url);
    } catch (err) {
      deps.logger.warn(
        { component: deps.component },
        `heartbeat ping failed: ${sanitizePingError(err)}`,
      );
    }
    if (deps.mirror !== undefined) {
      try {
        await deps.mirror();
      } catch (err) {
        deps.logger.warn(
          { component: deps.component },
          `heartbeat DB mirror failed: ${sanitizePingError(err)}`,
        );
      }
    }
  };

  const handle = scheduler.set(() => void beat(), deps.intervalMs);
  return { beat, stop: () => scheduler.clear(handle) };
}
