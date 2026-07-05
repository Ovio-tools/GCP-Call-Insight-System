import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type KeyLifecycleEventInsert,
  type KeyLifecycleEventRow,
  keyLifecycleEventInsertSchema,
  keyLifecycleEventRowSchema,
} from '../schemas/key-lifecycle-events.js';

const TABLE = 'key_lifecycle_events';

/**
 * key_lifecycle_events repository (Task 8.2) — append-only audit of the key lifecycle. Callers pass
 * SANITIZED metadata only (actor, approval_ref, blast-radius counts); never PII or key bytes. There
 * is no update/delete — the log is immutable.
 */
export async function insertLifecycleEvent(
  db: Queryable,
  input: KeyLifecycleEventInsert,
): Promise<KeyLifecycleEventRow> {
  const v = parseOrThrow(TABLE, keyLifecycleEventInsertSchema, input);
  const rows = await query<KeyLifecycleEventRow>(
    db,
    `INSERT INTO key_lifecycle_events
       (event, key_version, kek_version, actor, approval_ref, confirmation_matched,
        affected_raw_count, affected_vault_count, rows_reencrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      v.event,
      v.keyVersion ?? null,
      v.kekVersion ?? null,
      v.actor,
      v.approvalRef ?? null,
      v.confirmationMatched ?? null,
      v.affectedRawCount ?? null,
      v.affectedVaultCount ?? null,
      v.rowsReencrypted ?? null,
    ],
  );
  return parseOrThrow(TABLE, keyLifecycleEventRowSchema, rows[0]);
}

/** List events, optionally filtered by key_version / kek_version, newest first. */
export async function listLifecycleEvents(
  db: Queryable,
  filter: { keyVersion?: number; kekVersion?: string } = {},
): Promise<KeyLifecycleEventRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.keyVersion !== undefined) {
    params.push(filter.keyVersion);
    clauses.push(`key_version = $${params.length}`);
  }
  if (filter.kekVersion !== undefined) {
    params.push(filter.kekVersion);
    clauses.push(`kek_version = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await query<KeyLifecycleEventRow>(
    db,
    `SELECT * FROM key_lifecycle_events ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows.map((r) => parseOrThrow(TABLE, keyLifecycleEventRowSchema, r));
}
