import type { Pool } from 'pg';
import { listActive, recordAlertWithInsertStatus } from '../db/repositories/alert-events-repo.js';
import { type AlertEventRow } from '../db/schemas/alert-events.js';

/**
 * Escalation of unacknowledged critical alerts. Recording an escalation is ADDITIVE: a new
 * `alert_events` row keyed `escalation:<original>` via the existing `recordAlert` — no schema
 * change, idempotent under the partial unique index.
 */

/** Prefix marking an escalation row (and guarding against recursive escalation). */
export const ESCALATION_PREFIX = 'escalation:';

/**
 * Whether a critical alert has gone unacknowledged past its window and should escalate. Pure.
 * The prefix guard prevents recursive escalation: `listActive` returns escalation rows too
 * (they are critical + unacknowledged), so without it a stale `escalation:<key>` would spawn
 * `escalation:escalation:<key>`.
 */
export function shouldEscalate(alert: AlertEventRow, now: Date, windowMs: number): boolean {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive finite number');
  }
  const ageMs = now.getTime() - alert.created_at.getTime();
  return (
    alert.severity === 'critical' &&
    alert.acknowledged_at == null &&
    ageMs >= windowMs &&
    !alert.dedup_key.startsWith(ESCALATION_PREFIX)
  );
}

export interface EscalateOptions {
  /** The current time (injected so callers/tests control it). */
  now: Date;
  /** The unacknowledged window in milliseconds; must be positive and finite. */
  windowMs: number;
}

/** One escalation outcome: the escalation row plus whether THIS run created it. An existing
 * (deduped) escalation row returns `inserted: false` — the delivery layer must NOT re-send it,
 * leaving any owed retry to the backoff-honoring sweep. */
export interface EscalationResult {
  row: AlertEventRow;
  inserted: boolean;
}

/**
 * Escalate every active critical alert that has gone unacknowledged past `windowMs`, recording
 * one additive `escalation:<original>` row per stale alert and reporting, per row, whether THIS
 * run inserted it. Idempotent: a second run collapses onto the existing escalation row via the
 * dedup index and reports `inserted: false` for it. The insert status is what lets the caller
 * deliver a fresh escalation immediately while leaving an already-recorded one to the retry
 * sweep (so a failed escalation is not re-sent every run, bypassing its backoff).
 */
export async function escalateStaleAlertsWithInsertStatus(
  pool: Pool,
  opts: EscalateOptions,
): Promise<EscalationResult[]> {
  const active = await listActive(pool);
  const stale = active.filter((alert) => shouldEscalate(alert, opts.now, opts.windowMs));

  const escalated: EscalationResult[] = [];
  for (const row of stale) {
    const { row: created, inserted } = await recordAlertWithInsertStatus(pool, {
      errorCode: row.error_code,
      rootCauseCategory: row.root_cause_category,
      severity: 'critical',
      dedupKey: `${ESCALATION_PREFIX}${row.dedup_key}`,
      failureSnapshot: {
        escalated_from: row.dedup_key,
        original_created_at: row.created_at.toISOString(),
      },
    });
    escalated.push({ row: created, inserted });
  }
  return escalated;
}

/**
 * Escalate stale criticals, returning just the escalation rows. Backward-compatible thin
 * wrapper over {@link escalateStaleAlertsWithInsertStatus} — delivery-aware callers use the
 * `WithInsertStatus` variant to tell a freshly recorded escalation from a deduped one.
 */
export async function escalateStaleAlerts(
  pool: Pool,
  opts: EscalateOptions,
): Promise<AlertEventRow[]> {
  return (await escalateStaleAlertsWithInsertStatus(pool, opts)).map((r) => r.row);
}
