import { type Severity } from '../db/enums.js';
import { type ErrorCode, ERROR_CODES } from './categories.js';

/**
 * Default severity per error code. A separate deliverable from the remediation catalog:
 * `createFailure` uses this unless the caller explicitly overrides `severity`.
 *
 * There is no `UNKNOWN` fallback — `severityFor` throws on an unknown code.
 */
export const DEFAULT_SEVERITY: Record<ErrorCode, Severity> = {
  CONFIG_MISSING_OR_INVALID: 'high',
  DATABASE_UNAVAILABLE: 'critical',
  REDIS_UNAVAILABLE: 'critical',
  MIGRATION_FAILED: 'high',
  DIALPAD_AUTH_FAILED: 'high',
  DIALPAD_RATE_LIMITED: 'medium',
  DIALPAD_API_CHANGED: 'high',
  DIALPAD_TRANSCRIPT_MISSING: 'low',
  WEBHOOK_SIGNATURE_INVALID: 'medium',
  WEBHOOK_REPLAY_DETECTED: 'low',
  REDACTION_RECALL_REGRESSION: 'critical',
  REDACTION_LOW_CONFIDENCE: 'medium',
  MODEL_AUTH_FAILED: 'high',
  MODEL_RATE_LIMITED: 'medium',
  MODEL_MALFORMED_RESPONSE: 'medium',
  MODEL_COST_CAP_EXCEEDED: 'high',
  QUEUE_RETRY_EXHAUSTED: 'high',
  DEAD_LETTER_CREATED: 'high',
  RETENTION_PURGE_FAILED: 'high',
  BACKFILL_CHECKPOINT_FAILED: 'medium',
  REVIEW_QUEUE_STALLED: 'medium',
  SERVICETITAN_AUTH_FAILED: 'high',
  SERVICETITAN_MATCH_WEAK: 'low',
  SERVICETITAN_WRITE_FAILED: 'medium',
  // HTTP hardening & auth middleware (Task 2.3). Routine client rejections are low; an
  // unexpected boundary error is high (it logs at error level).
  REQUEST_BODY_TOO_LARGE: 'low',
  REQUEST_MALFORMED: 'low',
  UNSUPPORTED_MEDIA_TYPE: 'low',
  RATE_LIMIT_EXCEEDED: 'low',
  AUTH_REQUIRED: 'low',
  CSRF_TOKEN_INVALID: 'low',
  WEBHOOK_TIMESTAMP_INVALID: 'low',
  INTERNAL_ERROR: 'high',
  // Extract stage (Task 5.2). High, not medium: unlike the pre-egress redaction holds, a
  // post-extraction hit means residual PII may already have crossed the privacy boundary.
  VERBATIM_PII_DETECTED: 'high',
};

/** The default severity for a code. Throws on an unknown code (no fallback). */
export function severityFor(code: ErrorCode): Severity {
  const severity = DEFAULT_SEVERITY[code];
  if (!severity || !(ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`No default severity for error code: ${String(code)}`);
  }
  return severity;
}
