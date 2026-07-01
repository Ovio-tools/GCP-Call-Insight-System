export interface KeepAliveDeps {
  /** Register a shutdown handler. Injectable so tests drive it without real signals. */
  register?: (handler: () => void) => void;
  /** Acquire something that refs the event loop; returns a release fn. Injectable. */
  hold?: () => () => void;
}

/**
 * Hold the process open until a shutdown signal arrives, then resolve so the caller
 * can exit gracefully. Long-running services (webhook-receiver, worker) await this
 * after boot until real work lands; crons never call it.
 *
 * A pending Promise plus `process.once('SIGTERM', ...)` does NOT keep Node's event
 * loop alive — the process would exit right after boot. So the default `hold` refs
 * a timer (`setInterval` with the max non-clamped delay, 2^31-1 ms) and clears it on
 * shutdown, which is what actually keeps the loop alive. No busy loop: the empty
 * callback effectively never fires.
 */
export function keepAlive(deps: KeepAliveDeps = {}): Promise<void> {
  const register =
    deps.register ??
    ((handler: () => void): void => {
      process.once('SIGTERM', handler);
      process.once('SIGINT', handler);
    });
  const hold =
    deps.hold ??
    ((): (() => void) => {
      const handle = setInterval(
        () => {
          /* keep-alive tick: intentionally empty */
        },
        2 ** 31 - 1,
      );
      return () => clearInterval(handle);
    });

  return new Promise<void>((resolve) => {
    const release = hold();
    register(() => {
      release();
      resolve();
    });
  });
}
