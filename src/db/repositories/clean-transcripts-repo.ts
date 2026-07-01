import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type CleanTranscriptInsert,
  type CleanTranscriptRow,
  cleanTranscriptInsertSchema,
  cleanTranscriptRowSchema,
} from '../schemas/clean-transcripts.js';

const TABLE = 'clean_transcripts';

/** Idempotent upsert keyed on call_id — a re-run replaces the redacted text + score. */
export async function upsertCleanTranscript(
  pool: Pool,
  input: CleanTranscriptInsert,
): Promise<CleanTranscriptRow> {
  const v = parseOrThrow(TABLE, cleanTranscriptInsertSchema, input);
  const rows = await query<CleanTranscriptRow>(
    pool,
    `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons)
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb))
     ON CONFLICT (call_id) DO UPDATE SET
       redacted_text = EXCLUDED.redacted_text,
       redaction_risk_score = EXCLUDED.redaction_risk_score,
       redaction_reasons = EXCLUDED.redaction_reasons
     RETURNING *`,
    [v.callId, v.redactedText, v.redactionRiskScore.toFixed(4), toJsonParam(v.redactionReasons)],
  );
  return parseOrThrow(TABLE, cleanTranscriptRowSchema, rows[0]);
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
