import { query } from '../sql.js';
import type { Queryable } from '../types.js';

/** True if a call's raw/vault were physically purged (DB-B-local finality marker, ADR 0008 Move 2). */
export async function isRawPurged(db: Queryable, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    db,
    `SELECT 1 AS one FROM raw_purge_tombstone WHERE call_id = $1 LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/** Insert the finality tombstone for a call. Idempotent (ON CONFLICT DO NOTHING). */
export async function insertRawTombstone(db: Queryable, callId: string, now: Date): Promise<void> {
  await query(
    db,
    `INSERT INTO raw_purge_tombstone (call_id, purged_at) VALUES ($1, $2)
     ON CONFLICT (call_id) DO NOTHING`,
    [callId, now],
  );
}
