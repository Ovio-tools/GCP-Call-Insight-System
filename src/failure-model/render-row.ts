import type { AlertEventRow } from '../db/schemas/alert-events.js';
import { severitySchema } from '../db/enums.js';
import { errorCodeSchema, processingStateSchema } from './categories.js';
import { catalogFor } from './catalog.js';
import { severityFor } from './severity.js';
import { type FailureFields, failureFieldsSchema } from './error.js';
import { renderAlertText } from './alert.js';

/**
 * Render a PERSISTED `alert_events` row into the plain-language alert text, using ONLY data
 * on the row (Task 7.3). The retry sweep has nothing but the row, so the message must be
 * reconstructable from it alone.
 *
 * Two paths:
 *  1. If `failure_snapshot` is itself a full, valid `FailureFields` (what `emitAlert`
 *     persists), render it directly — the alert text is exactly what would have been sent.
 *  2. Otherwise (a legacy/partial snapshot from a direct `recordAlert` caller), reconstruct
 *     from `error_code`, letting CATALOG-DERIVED fields always win: because
 *     `failureFieldsSchema` requires `root_cause_category` (and the other catalog fields) to
 *     match `catalogFor(error_code)`, a stale/mismatched persisted `root_cause_category` would
 *     otherwise fail validation instead of recovering. The persisted `severity` (the
 *     authoritative column) is kept; a snapshot `processing_state` is kept only if valid; only
 *     sanitized `context` values survive (the schema's transform drops the rest).
 *
 * Throws when the row cannot be rendered safely (unknown `error_code`, or the reconstructed
 * object still fails validation). The caller treats a throw as a delivery failure and marks
 * the row `failed` with a sanitized error — it never crashes the sweep. The rendered text is
 * PII-incapable by construction (catalog/`renderAlertText`), so no transcript content, phone,
 * name, or token value can appear.
 */
export interface RenderAlertEventOptions {
  environment: string;
  now: Date;
}

/** Narrow an unknown jsonb value to a plain object (not array/null). */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function renderAlertEventText(row: AlertEventRow, opts: RenderAlertEventOptions): string {
  const timestamp = opts.now.toISOString();
  const snapshot = asObject(row.failure_snapshot);

  // Path 1: the snapshot is already a complete, valid failure — render it verbatim.
  const direct = failureFieldsSchema.safeParse(snapshot);
  if (direct.success) {
    return renderAlertText(direct.data, { environment: opts.environment, timestamp });
  }

  // Path 2: reconstruct from the code, catalog wins. errorCodeSchema.parse throws on an
  // unknown code, which the caller treats as an unrecoverable delivery failure.
  const code = errorCodeSchema.parse(row.error_code);
  const entry = catalogFor(code);
  const persistedSeverity = severitySchema.safeParse(row.severity);
  const snapshotProcessingState = processingStateSchema.safeParse(snapshot.processing_state);

  const reconstructed: FailureFields = failureFieldsSchema.parse({
    error_code: code,
    root_cause_category: entry.rootCauseCategory,
    severity: persistedSeverity.success ? persistedSeverity.data : severityFor(code),
    impact: entry.impact,
    // Not rendered in the alert text; kept valid so the schema accepts the object. Prefer a
    // valid persisted value, else a safe placeholder.
    processing_state: snapshotProcessingState.success ? snapshotProcessingState.data : 'degraded',
    remediation_now: entry.remediationNow,
    remediation_fix: entry.remediationFix,
    data_safe: entry.dataSafe,
    calls_state: entry.callsState,
    owner: entry.owner,
    runbook_ref: entry.runbookRef,
    // The schema's transform sanitizes context: only allowlisted, non-content keys survive.
    context: asObject(snapshot.context),
  });
  return renderAlertText(reconstructed, { environment: opts.environment, timestamp });
}
