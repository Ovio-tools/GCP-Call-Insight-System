/**
 * The client is a pure HTTP boundary: it knows nothing about the DB or the failure model.
 * It throws these lightweight, PII-free typed errors; the CALLER (the fetch-transcript
 * handler, or the reconciliation cron) maps `kind` to the shared failure-model code, adds
 * its own `{call_id, stage, environment}` context, persists the alert, and rethrows.
 *
 * Message text is deliberately generic (endpoint name + status + attempt count only) —
 * never a URL query, response body, header, or any transcript/PII value.
 */
export type DialpadFailureKind =
  /** 401/403 — credentials/scope problem. Caller → DIALPAD_AUTH_FAILED. */
  | 'auth'
  /** 429 after retries exhausted. Caller → DIALPAD_RATE_LIMITED (recommend waiting). */
  | 'rate_limited'
  /** 200 with an unparseable/unknown shape, or an unexpected 4xx. Caller → DIALPAD_API_CHANGED. */
  | 'api_changed'
  /** 5xx / network / timeout after retries exhausted. Transient — caller lets BullMQ retry. */
  | 'unavailable';

export interface DialpadErrorContext {
  /** Coarse endpoint label, e.g. `transcripts` or `calls`. Never the full URL. */
  endpoint: string;
  /** HTTP status if the failure came from a response (absent for network/timeout). */
  status?: number;
  /** Total HTTP attempts made (1 + retries). */
  attempts: number;
}

export class DialpadError extends Error {
  readonly kind: DialpadFailureKind;
  readonly endpoint: string;
  readonly status: number | undefined;
  readonly attempts: number;

  constructor(kind: DialpadFailureKind, ctx: DialpadErrorContext) {
    const statusPart = ctx.status !== undefined ? ` status ${ctx.status},` : '';
    super(
      `dialpad ${ctx.endpoint} request failed: ${kind} (${statusPart} attempts ${ctx.attempts})`,
    );
    this.name = 'DialpadError';
    this.kind = kind;
    this.endpoint = ctx.endpoint;
    this.status = ctx.status;
    this.attempts = ctx.attempts;
  }
}

/** True for the transient class the caller should let BullMQ retry rather than alert on. */
export function isRetryableDialpadError(err: unknown): err is DialpadError {
  return err instanceof DialpadError && err.kind === 'unavailable';
}
