import type { Pool } from 'pg';
import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type CleanTranscriptInsert,
  type CleanTranscriptRow,
  cleanTranscriptInsertSchema,
  cleanTranscriptRowSchema,
} from '../schemas/clean-transcripts.js';

const TABLE = 'clean_transcripts';

/**
 * Idempotent upsert keyed on call_id — a re-run replaces the redacted text + score and
 * clears a soft delete (a residual/unsafe hold followed by a passing rerun restores the
 * active row). A HARD-deleted row is never updated at all: retention's hard delete
 * removes plaintext, and redaction must not repopulate it — the guarded conflict
 * matches zero rows and this throws instead of silently succeeding.
 */
export async function upsertCleanTranscript(
  pool: Pool,
  input: CleanTranscriptInsert,
): Promise<CleanTranscriptRow> {
  const v = parseOrThrow(TABLE, cleanTranscriptInsertSchema, input);
  const rows = await query<CleanTranscriptRow>(
    pool,
    `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons, retention_eligible_at)
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb), now())
     ON CONFLICT (call_id) DO UPDATE SET
       redacted_text = EXCLUDED.redacted_text,
       redaction_risk_score = EXCLUDED.redaction_risk_score,
       redaction_reasons = EXCLUDED.redaction_reasons,
       -- Monotonic (Task 8.1 §2): the CLEAN retention clock starts at first creation and NEVER
       -- resets on a re-redaction rerun. Stamping at CREATION (not the mark-retention-eligible
       -- stage) is what makes a held call's redacted rows eventually purgeable — a held call may
       -- never reach the final stage. The blocking-review predicate keeps them until resolution.
       retention_eligible_at = COALESCE(clean_transcripts.retention_eligible_at, now()),
       soft_deleted_at = NULL
     WHERE clean_transcripts.hard_deleted_at IS NULL
     RETURNING *`,
    [v.callId, v.redactedText, v.redactionRiskScore.toFixed(4), toJsonParam(v.redactionReasons)],
  );
  if (rows.length === 0) {
    throw new DalError(
      DAL_QUERY_FAILED,
      `${DAL_QUERY_FAILED}: ${TABLE} row is hard-deleted; redaction may not repopulate it (retention conflict)`,
      { table: TABLE, call_id: v.callId },
    );
  }
  return parseOrThrow(TABLE, cleanTranscriptRowSchema, rows[0]);
}

/**
 * Soft-delete the active clean row (residual hit / unsafe risk hold): the current
 * redacted text may still contain PII and must stop being readable. Same hard-delete
 * guard as the upsert — redaction never mutates a retention-final row. Idempotent;
 * a missing or already-deleted row is a no-op.
 */
export async function softDeleteCleanTranscript(pool: Pool, callId: string): Promise<void> {
  await query(
    pool,
    `UPDATE clean_transcripts
        SET soft_deleted_at = now()
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
}

/**
 * True iff retention has HARD-deleted this call's clean transcript. The redact
 * stage preflights on this before writing ANYTHING (vault included): a known
 * retention-final call must not get partial vault/findings writes before the
 * clean-transcript guard would throw.
 */
export async function hasHardDeletedCleanTranscript(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query(
    pool,
    `SELECT 1 AS present FROM clean_transcripts
      WHERE call_id = $1 AND hard_deleted_at IS NOT NULL`,
    [callId],
  );
  return rows.length > 0;
}

export async function getCleanTranscript(
  pool: Pool,
  callId: string,
): Promise<CleanTranscriptRow | undefined> {
  const rows = await query<CleanTranscriptRow>(
    pool,
    `SELECT * FROM clean_transcripts
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, cleanTranscriptRowSchema, rows[0]) : undefined;
}
