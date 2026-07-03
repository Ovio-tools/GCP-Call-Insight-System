import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import { escalateStaleAlerts } from '../failure-model/index.js';
import type { AlertEventRow } from '../db/schemas/alert-events.js';
import { listRetryable } from '../db/repositories/alert-events-repo.js';
import { type DeliverDeps, deliverAlertRow } from './deliver.js';

/** Counts from one retry sweep. */
export interface SweepResult {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Retry sweep (Task 7.3): deliver every alert row still owed and due
 * (`delivery_state IN (pending, failed)`, backoff elapsed, under the max-attempts cap),
 * exactly once each. So an incident whose first delivery failed — OR one inserted by a direct
 * `recordAlert` caller that never attempted delivery — is eventually sent once; duplicates
 * arriving before the retry still resolve to the single row's one delivery. When
 * `ALERT_WEBHOOK_URL` is unset the sweep no-ops (logged), leaving rows `pending`.
 */
export async function retryPendingDeliveries(
  pool: Pool,
  config: Config,
  deps: DeliverDeps,
): Promise<SweepResult> {
  const result: SweepResult = { attempted: 0, delivered: 0, failed: 0, skipped: 0 };
  if (!config.ALERT_WEBHOOK_URL) {
    deps.logger.info({ component: 'alerting' }, 'ALERT_WEBHOOK_URL unset — retry sweep no-op');
    return result;
  }
  const rows = await listRetryable(pool, {
    now: deps.now,
    maxAttempts: config.ALERT_DELIVERY_MAX_ATTEMPTS,
  });
  for (const row of rows) {
    const outcome = await deliverAlertRow(pool, config, row, deps);
    result.attempted += 1;
    if (outcome === 'delivered') result.delivered += 1;
    else if (outcome === 'failed') result.failed += 1;
    else result.skipped += 1;
  }
  return result;
}

export interface EscalateAndDeliverDeps extends DeliverDeps {
  /** The unacknowledged-critical escalation window (ms). Caller derives this from
   * `ALERT_ESCALATION_WINDOW_MINUTES` so there is one source of truth. */
  windowMs: number;
}

/**
 * Escalate unacknowledged criticals and deliver each escalation (Task 7.3). Records one
 * additive `escalation:<original>` row per stale alert (idempotent via the dedup index) and
 * delivers it through the same webhook, best-effort. Delivery never throws; a
 * `escalateStaleAlerts` DB error propagates to the caller, which wraps this so it can never
 * fail a successful reconciliation. Returns the escalation rows.
 */
export async function escalateAndDeliver(
  pool: Pool,
  config: Config,
  deps: EscalateAndDeliverDeps,
): Promise<AlertEventRow[]> {
  const escalated = await escalateStaleAlerts(pool, { now: deps.now, windowMs: deps.windowMs });
  for (const row of escalated) {
    await deliverAlertRow(pool, config, row, deps);
  }
  return escalated;
}
