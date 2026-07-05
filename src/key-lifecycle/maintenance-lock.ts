import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Maintenance-lock module (Task 8.2). Rotation pauses the pipeline so it can re-encrypt raw/vault
 * rows without the worker mutating them mid-sweep. The pause is GLOBAL, via the BullMQ `Queue`
 * connection (`queue.pause()`), so every worker instance stops FETCHING new jobs — the rotation CLI
 * has no local `Worker` to `worker.pause()`. A Redis maintenance flag additionally lets the
 * processor's defensive backstop re-delay a job it had ALREADY fetched before the pause landed,
 * without consuming a retry (see the worker backstop).
 */
const MAINTENANCE_KEY = 'key-lifecycle:maintenance';

export async function setMaintenance(redis: Redis): Promise<void> {
  await redis.set(MAINTENANCE_KEY, '1');
}
export async function clearMaintenance(redis: Redis): Promise<void> {
  await redis.del(MAINTENANCE_KEY);
}
export async function isMaintenanceActive(redis: Redis): Promise<boolean> {
  return (await redis.exists(MAINTENANCE_KEY)) === 1;
}

/** Pause consumption GLOBALLY (Redis-backed) so all workers stop fetching. NOT `worker.pause()`. */
export async function pauseQueue(queue: Queue): Promise<void> {
  await queue.pause();
}
export async function resumeQueue(queue: Queue): Promise<void> {
  await queue.resume();
}

export interface DrainOptions {
  timeoutMs: number;
  pollMs?: number;
  /** Injectable clock/sleep so the timeout path is testable without real waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll the active-job count until it reaches zero (in-flight jobs drained) or the timeout elapses.
 * Returns `true` if drained, `false` on timeout — rotation aborts safely (releases locks, resumes
 * the queue, emits KEY_ROTATION_FAILED) on `false` rather than re-encrypting under live mutation.
 */
export async function waitForDrain(queue: Queue, opts: DrainOptions): Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 100;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const active = await queue.getActiveCount();
    if (active === 0) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}
