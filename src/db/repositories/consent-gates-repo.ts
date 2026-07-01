import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type ConsentGateInsert,
  type ConsentGateRow,
  consentGateInsertSchema,
  consentGateRowSchema,
} from '../schemas/consent-gates.js';

const TABLE = 'consent_gates';

/** Record a consent/legal gate. Append-only audit record. */
export async function recordConsent(pool: Pool, input: ConsentGateInsert): Promise<ConsentGateRow> {
  const v = parseOrThrow(TABLE, consentGateInsertSchema, input);
  const rows = await query<ConsentGateRow>(
    pool,
    `INSERT INTO consent_gates (gate_type, recorded_by, evidence_ref)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [v.gateType, v.recordedBy, v.evidenceRef ?? null],
  );
  return parseOrThrow(TABLE, consentGateRowSchema, rows[0]);
}

export async function listByType(pool: Pool, gateType: string): Promise<ConsentGateRow[]> {
  const rows = await query<ConsentGateRow>(
    pool,
    `SELECT * FROM consent_gates WHERE gate_type = $1 ORDER BY recorded_at`,
    [gateType],
  );
  return rows.map((r) => parseOrThrow(TABLE, consentGateRowSchema, r));
}
