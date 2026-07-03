/**
 * Worker liveness probe (Task 7.1). Supplies the `isHealthy` gate for the worker's
 * {@link startLivenessHeartbeat}. It answers one question honestly: is THIS worker still
 * consuming? A beat only goes out when the answer is yes, so a dead consumer stops looking
 * alive and its external check alerts — the whole point of the dead-man's switch.
 *
 * Two failure modes it must catch, both of which the earlier version missed:
 *   1. The BullMQ run loop rejected or closed — `worker.isRunning()` flips false in run()'s
 *      `finally`. A worker meant to be consuming that is no longer running is not alive.
 *   2. The worker's OWN consuming Redis connection is unreachable. We probe THAT connection,
 *      never a side/producer connection — a healthy producer link must not keep the worker
 *      looking alive while the consumer is dead.
 */

/** The slice of a BullMQ Worker we depend on: whether its run loop is live. */
export interface RunLoopStatus {
  isRunning(): boolean;
}

/** The slice of a Redis client we depend on: a round-trip liveness ping. */
export interface RedisPingable {
  ping(): Promise<unknown>;
}

export function createWorkerLivenessProbe(deps: {
  worker: RunLoopStatus;
  /** The worker's OWN consuming connection — not the queue's producer connection. */
  connection: RedisPingable;
  /**
   * Whether this worker is meant to be consuming (kill switch off). A kill-switched worker is
   * intentionally not running yet is still a live process that should keep beating, gated only
   * on Redis reachability — so the run-loop check is skipped for it.
   */
  shouldConsume: boolean;
}): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    if (deps.shouldConsume && !deps.worker.isRunning()) return false;
    // Confirm the consumer can still reach Redis. A rejection here propagates: the heartbeat
    // treats a throwing probe as unhealthy and skips the beat.
    await deps.connection.ping();
    return true;
  };
}
