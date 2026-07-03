import type { JsonValue } from '../db/types.js';
import type { FailureFields } from './error.js';

/**
 * The canonical `failure_snapshot` payload: the full §4 failure fields, sanitized. This is
 * the SINGLE serializer every producer uses so the same complete snapshot lands in
 * `alert_events`, `processing_log` failure rows, AND `dead_letter` — a failure stays
 * explainable after the alert is gone (build plan §7.4). `context` is already sanitized by
 * {@link FailureError} construction (allowlist: call_id, job_id, environment, stage,
 * component), so the snapshot can never carry transcript content or PII.
 *
 * `renderAlertEventText` path-1 renders the exact alert text from this shape alone.
 */
export interface FailureSnapshot extends Record<string, JsonValue> {
  error_code: string;
  root_cause_category: string;
  severity: string;
  impact: string;
  processing_state: string;
  remediation_now: string;
  remediation_fix: string;
  data_safe: boolean;
  calls_state: string;
  owner: string;
  runbook_ref: string;
  context: Record<string, string>;
}

/** Serialize a failure's full §4 fields into the persisted snapshot payload. */
export function failureSnapshot(f: FailureFields): FailureSnapshot {
  return {
    error_code: f.error_code,
    root_cause_category: f.root_cause_category,
    severity: f.severity,
    impact: f.impact,
    processing_state: f.processing_state,
    remediation_now: f.remediation_now,
    remediation_fix: f.remediation_fix,
    data_safe: f.data_safe,
    calls_state: f.calls_state,
    owner: f.owner,
    runbook_ref: f.runbook_ref,
    context: f.context,
  };
}
