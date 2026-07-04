import type { Pool } from 'pg';
import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
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
 *
 * Retention eligibility is stamped at CREATION and kept MONOTONIC (Task 8.1 §2). Because a
 * replace deletes + re-inserts (no single row to COALESCE onto), the replacement rows inherit
 * the call-level `min(retention_eligible_at)` across the call's existing findings (active OR
 * soft-deleted history), falling back to `now()` on the very first write. So a rerun after time
 * advances keeps the ORIGINAL clock — the CLEAN retention window is measured from first
 * redaction, decoupled from pipeline completion (held calls may never finish).
 */
export async function replaceFindings(
  pool: Pool,
  callId: string,
  findings: RedactionFindingInsert[],
): Promise<void> {
  const validated = findings.map((f) => parseOrThrow(TABLE, redactionFindingInsertSchema, f));
  await withTransaction(pool, async (client) => {
    // Retention-finality guard (Task 8.1 §6, MANDATORY): refuse to repopulate if EITHER the
    // parent clean transcript is hard-deleted OR any findings tombstone exists for this call —
    // enforced at the writer so a caller that bypasses the redact preflight still cannot recreate
    // scrubbed findings. `replaceFindings` deletes + re-inserts (no per-row conflict to guard on),
    // so the check is an explicit preflight inside the same transaction.
    const blocked = await query<{ one: number }>(
      client,
      `SELECT 1 AS one FROM clean_transcripts WHERE call_id = $1 AND hard_deleted_at IS NOT NULL
       UNION ALL
       SELECT 1 AS one FROM redaction_findings WHERE call_id = $1 AND hard_deleted_at IS NOT NULL
       LIMIT 1`,
      [callId],
    );
    if (blocked.length > 0) {
      throw new DalError(
        DAL_QUERY_FAILED,
        `${DAL_QUERY_FAILED}: ${TABLE} is retention-final (hard-deleted findings or clean transcript); redaction may not repopulate it (retention conflict)`,
        { table: TABLE, call_id: callId },
      );
    }

    // Read the call's earliest existing stamp BEFORE soft-deleting (soft-delete leaves
    // retention_eligible_at untouched); NULL on the first-ever write for this call.
    const existing = await query<{ min_eligible: Date | null }>(
      client,
      `SELECT min(retention_eligible_at) AS min_eligible FROM redaction_findings WHERE call_id = $1`,
      [callId],
    );
    const inheritedEligibleAt = existing[0]?.min_eligible ?? null;

    await query(
      client,
      `UPDATE redaction_findings SET soft_deleted_at = now()
        WHERE call_id = $1 AND soft_deleted_at IS NULL`,
      [callId],
    );
    for (const f of validated) {
      await query(
        client,
        `INSERT INTO redaction_findings
           (call_id, entity_type, token_ref, value_hash, residual_scan_result, retention_eligible_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), COALESCE($6, now()))`,
        [
          callId,
          f.entityType,
          f.tokenRef ?? null,
          f.valueHash ?? null,
          toJsonParam(f.residualScanResult),
          inheritedEligibleAt,
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
