import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type EvaluationReportRow,
  type InsertEvaluationReportInput,
  evaluationReportRowSchema,
  insertEvaluationReportSchema,
} from '../schemas/evaluation-reports.js';

const TABLE = 'evaluation_reports';

/**
 * Insert one PII-free evaluation report (Task 6.3). `summary` is grouped counts and `failures` is a
 * bounded ids/enums-only sample — the insert schema + DB CHECKs guarantee no content columns and a
 * consistent status × skip_reason. Append-only; no idempotency key (each run is its own report).
 */
export async function insertEvaluationReport(
  db: Queryable,
  input: InsertEvaluationReportInput,
): Promise<EvaluationReportRow> {
  const v = parseOrThrow(TABLE, insertEvaluationReportSchema, input);
  const rows = await query<EvaluationReportRow>(
    db,
    `INSERT INTO evaluation_reports
       (eval_set_version, pii_gate_version, mode, status, skip_reason, generated_at,
        summary, failures, examples_evaluated, examples_skipped)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      v.evalSetVersion,
      v.piiGateVersion,
      v.mode,
      v.status,
      v.skipReason,
      v.generatedAt,
      toJsonParam(v.summary),
      toJsonParam(v.failures),
      v.examplesEvaluated,
      v.examplesSkipped,
    ],
  );
  return parseOrThrow(TABLE, evaluationReportRowSchema, rows[0]);
}
