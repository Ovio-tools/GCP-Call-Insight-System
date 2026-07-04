import type { ErrorCode, FailureFields } from '../failure-model/index.js';

/**
 * The single choke point for turning a failure into an HTTP response. The response body is a
 * deliberately minimal, PII-free projection — `{ error, message }` — NOT the full alert. The
 * catalog's remediation/owner/runbook and any `context` values are operational detail that
 * goes only to the structured log, never to an HTTP client.
 */

/** HTTP status per middleware-produced error code. Anything else defaults to 500. */
const HTTP_STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  REQUEST_BODY_TOO_LARGE: 413,
  REQUEST_MALFORMED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMIT_EXCEEDED: 429,
  AUTH_REQUIRED: 401,
  AUTH_FORBIDDEN: 403,
  CSRF_TOKEN_INVALID: 403,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_TIMESTAMP_INVALID: 400,
  WEBHOOK_REPLAY_DETECTED: 409,
  INTERNAL_ERROR: 500,
};

/** Terse, client-safe messages. Never echoes request content, remediation, or internals. */
const PUBLIC_MESSAGE_BY_CODE: Partial<Record<ErrorCode, string>> = {
  REQUEST_BODY_TOO_LARGE: 'Request body too large.',
  REQUEST_MALFORMED: 'Malformed request body.',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported content type.',
  RATE_LIMIT_EXCEEDED: 'Too many requests.',
  AUTH_REQUIRED: 'Authentication required.',
  AUTH_FORBIDDEN: 'Forbidden.',
  CSRF_TOKEN_INVALID: 'Invalid or missing CSRF token.',
  WEBHOOK_SIGNATURE_INVALID: 'Invalid signature.',
  WEBHOOK_TIMESTAMP_INVALID: 'Invalid or stale timestamp.',
  WEBHOOK_REPLAY_DETECTED: 'Duplicate event.',
  INTERNAL_ERROR: 'Internal server error.',
};

export interface HttpErrorResponse {
  status: number;
  body: { error: ErrorCode; message: string };
}

/** Map a failure to its HTTP status. Unknown codes are treated as a 500. */
export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

/**
 * Build the safe HTTP response for a failure. Returns only `{ error, message }`; the caller
 * (the error handler) attaches the request id and does the logging.
 */
export function toHttpError(failure: Pick<FailureFields, 'error_code'>): HttpErrorResponse {
  const code = failure.error_code;
  return {
    status: httpStatusFor(code),
    body: { error: code, message: PUBLIC_MESSAGE_BY_CODE[code] ?? 'Request failed.' },
  };
}
