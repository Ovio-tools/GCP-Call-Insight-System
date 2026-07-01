import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam, withTransaction } from '../sql.js';
import {
  type RedactionFindingInsert,
  type RedactionFindingRow,
  redactionFindingInsertSchema,
  redactionFindingRowSchema,
} from '../schemas/redaction-findings.js';

const TABLE = 'redaction_findings';

/**
 * Idempotent per-call replacement of the finding set. There is no natural per-row key
 * and `app_role` has no DELETE, so a re-run soft-deletes the call's current findings
 * (UPDATE `soft_deleted_at`) and inserts the new set — all in one transaction. History
 * is retained for the retention cron; reads filter it out. "Deletes are soft first."
 */
export async function replaceFindings(
  pool: Pool,
  callId: string,
  findings: RedactionFindingInsert[],
): Promise<void> {
  const validated = findings.map((f) => parseOrThrow(TABLE, redactionFindingInsertSchema, f));
  await withTransaction(pool, async (client) => {
    await query(
      client,
      `UPDATE redaction_findings SET soft_deleted_at = now()
        WHERE call_id = $1 AND soft_deleted_at IS NULL`,
      [callId],
    );
    for (const f of validated) {
      await query(
        client,
        `INSERT INTO redaction_findings (call_id, entity_type, token_ref, value_hash, residual_scan_result)
         VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))`,
        [
          callId,
          f.entityType,
          f.tokenRef ?? null,
          f.valueHash ?? null,
          toJsonParam(f.residualScanResult),
        ],
      );
    }
  });
}

/** Active findings for a call — excludes soft-deleted history rows. */
export async function getFindings(pool: Pool, callId: string): Promise<RedactionFindingRow[]> {
  const rows = await query<RedactionFindingRow>(
    pool,
    `SELECT * FROM redaction_findings
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL
      ORDER BY created_at`,
    [callId],
  );
  return rows.map((r) => parseOrThrow(TABLE, redactionFindingRowSchema, r));
}
