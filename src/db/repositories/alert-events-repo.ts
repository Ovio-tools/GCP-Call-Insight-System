import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type AlertEventInsert,
  type AlertEventRow,
  alertEventInsertSchema,
  alertEventRowSchema,
} from '../schemas/alert-events.js';

const TABLE = 'alert_events';

/**
 * Record an alert. Deduplicated by `dedup_key` while unacknowledged (matches the partial
 * unique index): a repeat of a still-open incident does not create a second row — the
 * existing live alert is returned instead. A resolved incident may recur.
 */
export async function recordAlert(pool: Pool, input: AlertEventInsert): Promise<AlertEventRow> {
  const v = parseOrThrow(TABLE, alertEventInsertSchema, input);
  const inserted = await query<AlertEventRow>(
    pool,
    `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, failure_snapshot)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
     ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL DO NOTHING
     RETURNING *`,
    [v.errorCode, v.rootCauseCategory, v.severity, v.dedupKey, toJsonParam(v.failureSnapshot)],
  );
  if (inserted[0]) {
    return parseOrThrow(TABLE, alertEventRowSchema, inserted[0]);
  }
  // Deduped: return the live alert that already holds this dedup_key.
  const existing = await query<AlertEventRow>(
    pool,
    `SELECT * FROM alert_events WHERE dedup_key = $1 AND acknowledged_at IS NULL`,
    [v.dedupKey],
  );
  return parseOrThrow(TABLE, alertEventRowSchema, existing[0]);
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
