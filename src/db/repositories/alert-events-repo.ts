import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type AlertEventInsert,
  type AlertEventRow,
  alertEventInsertSchema,
  alertEventRowSchema,
} from '../schemas/alert-events.js';

const TABLE = 'alert_events';

/** The outcome of an insert attempt: the live row plus whether THIS call created it. A
 * duplicate of a still-open incident returns the existing row with `inserted: false`. */
export interface RecordAlertResult {
  row: AlertEventRow;
  inserted: boolean;
}

/**
 * Record an alert, reporting whether this call actually inserted a new row (Task 7.3).
 * Deduplicated by `dedup_key` while unacknowledged (matches the partial unique index): a
 * repeat of a still-open incident does not create a second row — the existing live alert is
 * returned with `inserted: false`. A resolved incident may recur.
 *
 * A newly inserted row carries the delivery-column defaults (`pending`, `next_attempt_at =
 * now()`), so it is a retryable delivery obligation the moment it exists — even a direct
 * caller that never attempts delivery is covered by the retry sweep. A duplicate does NOT
 * reset delivery state, so a once-delivered incident is never re-sent.
 */
export async function recordAlertWithInsertStatus(
  db: Queryable,
  input: AlertEventInsert,
): Promise<RecordAlertResult> {
  // Accepts any `Queryable` (a pool for a one-shot insert, or a transaction client to enlist the
  // insert in an open transaction — used by the Task 7.2 warning emitter's lock→check→insert).
  const v = parseOrThrow(TABLE, alertEventInsertSchema, input);
  const inserted = await query<AlertEventRow>(
    db,
    `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, failure_snapshot)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
     ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL DO NOTHING
     RETURNING *`,
    [v.errorCode, v.rootCauseCategory, v.severity, v.dedupKey, toJsonParam(v.failureSnapshot)],
  );
  if (inserted[0]) {
    return { row: parseOrThrow(TABLE, alertEventRowSchema, inserted[0]), inserted: true };
  }
  // Deduped: return the live alert that already holds this dedup_key.
  const existing = await query<AlertEventRow>(
    db,
    `SELECT * FROM alert_events WHERE dedup_key = $1 AND acknowledged_at IS NULL`,
    [v.dedupKey],
  );
  return { row: parseOrThrow(TABLE, alertEventRowSchema, existing[0]), inserted: false };
}

/**
 * Record an alert. Backward-compatible thin wrapper over
 * {@link recordAlertWithInsertStatus} that returns only the row, so the existing direct
 * callers (and their tests) keep compiling unchanged — only delivery/escalation-aware code
 * needs `{ inserted }`.
 */
export async function recordAlert(db: Queryable, input: AlertEventInsert): Promise<AlertEventRow> {
  const { row } = await recordAlertWithInsertStatus(db, input);
  return row;
}

export async function acknowledgeAlert(pool: Pool, dedupKey: string): Promise<number> {
  const rows = await query<{ id: string }>(
    pool,
    `UPDATE alert_events SET acknowledged_at = now()
      WHERE dedup_key = $1 AND acknowledged_at IS NULL
      RETURNING id`,
    [dedupKey],
  );
  return rows.length;
}

export async function listActive(pool: Pool): Promise<AlertEventRow[]> {
  const rows = await query<AlertEventRow>(
    pool,
    `SELECT * FROM alert_events WHERE acknowledged_at IS NULL ORDER BY created_at`,
  );
  return rows.map((r) => parseOrThrow(TABLE, alertEventRowSchema, r));
}

/** Alert counts grouped by error_code + severity — the `alerts_total` metric (Task 7.4).
 *  Both labels are closed, low-cardinality sets (catalog codes × 4 severities). Read-only. */
export interface AlertCodeSeverityCount {
  error_code: string;
  severity: string;
  count: number;
}
export async function countAlertsByCodeSeverity(pool: Pool): Promise<AlertCodeSeverityCount[]> {
  return query<AlertCodeSeverityCount>(
    pool,
    `SELECT error_code, severity::text AS severity, count(*)::int AS count
       FROM alert_events
      GROUP BY error_code, severity
      ORDER BY error_code, severity`,
  );
}

/** The newest still-active (unacknowledged) alert, or undefined when none — the status
 * surface's `latest_issue` / broken-cause source. */
export async function latestActive(pool: Pool): Promise<AlertEventRow | undefined> {
  const rows = await query<AlertEventRow>(
    pool,
    `SELECT * FROM alert_events WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0] ? parseOrThrow(TABLE, alertEventRowSchema, rows[0]) : undefined;
}

/**
 * The newest unacknowledged alerts, newest first, bounded to `limit`. The status surface scans
 * these and shows the newest whose underlying signal is STILL active — a component-scoped alert
 * auto-expires from the banner once its component reports healthy again (see aggregate.ts). Same
 * ordering as {@link latestActive} so the first non-recovered row is the banner issue.
 */
export async function recentUnacknowledged(pool: Pool, limit: number): Promise<AlertEventRow[]> {
  const rows = await query<AlertEventRow>(
    pool,
    `SELECT * FROM alert_events WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => parseOrThrow(TABLE, alertEventRowSchema, r));
}

/**
 * Alerts whose delivery is still owed and due (Task 7.3): `delivery_state` is `pending` or
 * `failed`, the backoff has elapsed (`COALESCE(next_attempt_at, created_at) <= now`, defensive
 * even though the column is NOT NULL), and the max-attempts cap has not been hit. Oldest first
 * so the earliest incident is delivered first. This is the retry sweep's selection.
 */
export async function listRetryable(
  pool: Pool,
  opts: { now: Date; maxAttempts: number },
): Promise<AlertEventRow[]> {
  const rows = await query<AlertEventRow>(
    pool,
    `SELECT * FROM alert_events
      WHERE delivery_state IN ('pending', 'failed')
        AND COALESCE(next_attempt_at, created_at) <= $1
        AND delivery_attempts < $2
      ORDER BY created_at`,
    [opts.now, opts.maxAttempts],
  );
  return rows.map((r) => parseOrThrow(TABLE, alertEventRowSchema, r));
}

/**
 * Atomically claim a row for ONE delivery attempt (Task 7.3, concurrency-safe). A single
 * UPDATE that does two things at once, before anything observable happens:
 *
 *  1. Compare-and-swap on `delivery_attempts` — matches only when the row is still owed
 *     (`delivery_state IN ('pending', 'failed')`), under the max-attempts cap, AND its attempt
 *     count is exactly what the caller read (`expectedAttempts`). This fences two callers that
 *     read the SAME pre-claim row: only one CAS wins.
 *  2. Leases the row OUT of retry-eligibility by pushing `next_attempt_at` to `leaseUntil`
 *     (the backoff instant for this attempt). This fences a DIFFERENT racer — a fresh sweep
 *     that reads AFTER the claim commits but before delivery resolves: {@link listRetryable}
 *     filters on `next_attempt_at`, so the just-leased row is invisible to it until the lease
 *     elapses (which also recovers a row whose deliverer crashed mid-POST).
 *
 * The winner gets the row back with `delivery_attempts` already incremented; a losing claimant
 * — or a repeat escalation run whose row is already `delivered` — matches nothing and gets
 * `undefined`, so only the winner POSTs. There is deliberately no `next_attempt_at <= now`
 * gate in the WHERE: retry-eligibility is filtered upstream by {@link listRetryable} while the
 * immediate-delivery path must send a just-inserted row now regardless of its default
 * `next_attempt_at`. Attempt counting lives HERE, before the POST, so no caller double-counts.
 */
export async function claimAlertForDelivery(
  pool: Pool,
  opts: { id: string; expectedAttempts: number; maxAttempts: number; leaseUntil: Date },
): Promise<AlertEventRow | undefined> {
  const rows = await query<AlertEventRow>(
    pool,
    `UPDATE alert_events
        SET delivery_attempts = delivery_attempts + 1,
            next_attempt_at = $4
      WHERE id = $1
        AND delivery_state IN ('pending', 'failed')
        AND delivery_attempts = $2
        AND delivery_attempts < $3
      RETURNING *`,
    [opts.id, opts.expectedAttempts, opts.maxAttempts, opts.leaseUntil],
  );
  return rows[0] ? parseOrThrow(TABLE, alertEventRowSchema, rows[0]) : undefined;
}

/**
 * Mark a claimed row delivered, idempotently: the `delivery_state <> 'delivered'` guard means
 * a second (concurrent) mark of the same row is a no-op, so an incident is delivered exactly
 * once. The attempt count is NOT touched here — {@link claimAlertForDelivery} already counted
 * this attempt before the POST. Returns the updated row, or undefined when already delivered.
 */
export async function markDelivered(pool: Pool, id: string): Promise<AlertEventRow | undefined> {
  const rows = await query<AlertEventRow>(
    pool,
    `UPDATE alert_events
        SET delivery_state = 'delivered',
            delivered_at = now(),
            last_delivery_error = NULL
      WHERE id = $1 AND delivery_state <> 'delivered'
      RETURNING *`,
    [id],
  );
  return rows[0] ? parseOrThrow(TABLE, alertEventRowSchema, rows[0]) : undefined;
}

/**
 * Mark a claimed delivery attempt failed and schedule the next: move to `failed`, set
 * `next_attempt_at` to the backoff instant, and store a SANITIZED error string (the caller
 * must never pass the webhook URL, a secret, or PII). The attempt count is NOT touched here —
 * {@link claimAlertForDelivery} already counted this attempt. A delivered row is left
 * untouched (the guard) so a late failure can't undo a success.
 */
export async function markFailed(
  pool: Pool,
  id: string,
  opts: { nextAttemptAt: Date; error: string },
): Promise<AlertEventRow | undefined> {
  const rows = await query<AlertEventRow>(
    pool,
    `UPDATE alert_events
        SET delivery_state = 'failed',
            next_attempt_at = $2,
            last_delivery_error = $3
      WHERE id = $1 AND delivery_state <> 'delivered'
      RETURNING *`,
    [id, opts.nextAttemptAt, opts.error],
  );
  return rows[0] ? parseOrThrow(TABLE, alertEventRowSchema, rows[0]) : undefined;
}
