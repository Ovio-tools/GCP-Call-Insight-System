import type { Pool } from 'pg';
import { listActive, recordAlert } from '../db/repositories/alert-events-repo.js';
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

/**
 * Escalate every active critical alert that has gone unacknowledged past `windowMs`, recording
 * one additive `escalation:<original>` row per stale alert. Idempotent: a second run collapses
 * onto the existing escalation row via the dedup index. Returns the escalation rows.
 */
export async function escalateStaleAlerts(
  pool: Pool,
  opts: EscalateOptions,
): Promise<AlertEventRow[]> {
  const active = await listActive(pool);
  const stale = active.filter((alert) => shouldEscalate(alert, opts.now, opts.windowMs));

  const escalated: AlertEventRow[] = [];
  for (const row of stale) {
    const created = await recordAlert(pool, {
      errorCode: row.error_code,
      rootCauseCategory: row.root_cause_category,
      severity: 'critical',
      dedupKey: `${ESCALATION_PREFIX}${row.dedup_key}`,
      failureSnapshot: {
        escalated_from: row.dedup_key,
        original_created_at: row.created_at.toISOString(),
      },
    });
    escalated.push(created);
  }
  return escalated;
}
