/**
 * Provider-neutral heartbeat transport (Task 7.1). The app is handed a full check URL and
 * performs a minimal, timed HTTP GET — no monitoring vendor is hardcoded. Every failure is
 * normalized so the check URL (which Node's `fetch` embeds in network-error messages) can
 * never reach a log line, dead-letter row, or alert.
 */

/** Pings a single fully-formed check URL. Injectable so tests never hit a real monitor. */
export type HeartbeatPinger = (url: string) => Promise<void>;

/**
 * A ping failure whose message is guaranteed URL-free — it carries only an HTTP status
 * number or a coarse reason (`timeout`, an error class name). Safe to log verbatim.
 */
export class HeartbeatPingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatPingError';
  }
}

/** Class name of an unknown throwable — never its message (fetch messages embed the URL). */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return typeof err;
}

/**
 * Reduce any throwable to a log-safe string. A {@link HeartbeatPingError} is trusted (its
 * message is URL-free by construction); anything else is reduced to a class name so a URL,
 * token, or other secret sitting in a raw error message can never escape.
 */
export function sanitizePingError(err: unknown): string {
  if (err instanceof HeartbeatPingError) return err.message;
  return `ping error (${errorName(err)})`;
}

/**
 * Build a provider-neutral pinger: a GET with an AbortController timeout. Any non-2xx or
 * transport/timeout failure becomes a {@link HeartbeatPingError} carrying a status number or
 * coarse reason but NEVER the URL. The URL never appears in the thrown error.
 */
export function httpPing(timeoutMs: number): HeartbeatPinger {
  return async (url: string): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) throw new HeartbeatPingError(`external check returned status ${res.status}`);
    } catch (err) {
      if (err instanceof HeartbeatPingError) throw err;
      // A timed-out request aborts; otherwise report only the error class, never its message.
      const reason = controller.signal.aborted ? 'timeout' : errorName(err);
      throw new HeartbeatPingError(`external check unreachable (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  };
}
