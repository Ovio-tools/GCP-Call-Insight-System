/**
 * Outbound alert-webhook transport (Task 7.3). A minimal, timed HTTP POST of a Slack-
 * compatible `{ text }` body. Like the heartbeat pinger, every failure is normalized so the
 * webhook URL (which Node's `fetch` embeds in network-error messages) can NEVER reach a log
 * line, the `alert_events.last_delivery_error` column, or an alert — only an HTTP status
 * number or a coarse reason survives.
 */

/** Delivers rendered alert text to a fully-formed webhook URL. Injectable for tests. */
export type AlertWebhookPoster = (url: string, text: string, timeoutMs: number) => Promise<void>;

/** A delivery failure whose message is guaranteed URL-free (status number or coarse reason). */
export class AlertWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertWebhookError';
  }
}

/** Class name of an unknown throwable — never its message (fetch messages embed the URL). */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return typeof err;
}

/** Reduce any throwable to a log-safe, URL-free string for `last_delivery_error` / logs. */
export function sanitizeWebhookError(err: unknown): string {
  if (err instanceof AlertWebhookError) return err.message;
  return `delivery error (${errorName(err)})`;
}

/**
 * The default poster: a JSON POST with an AbortController timeout. Any non-2xx or transport/
 * timeout failure becomes an {@link AlertWebhookError} carrying a status number or coarse
 * reason but NEVER the URL or the body.
 */
export function httpPostAlert(): AlertWebhookPoster {
  return async (url: string, text: string, timeoutMs: number): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) throw new AlertWebhookError(`alert webhook returned status ${res.status}`);
    } catch (err) {
      if (err instanceof AlertWebhookError) throw err;
      const reason = controller.signal.aborted ? 'timeout' : errorName(err);
      throw new AlertWebhookError(`alert webhook unreachable (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  };
}
