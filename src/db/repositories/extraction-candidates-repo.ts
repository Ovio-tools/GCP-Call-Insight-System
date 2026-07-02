import type { Pool } from 'pg';
import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type ExtractionCandidateInsert,
  type ExtractionCandidateRow,
  type PiiScanFailure,
  extractionCandidateInsertSchema,
  extractionCandidateRowSchema,
  piiScanFailureSchema,
} from '../schemas/extraction-candidates.js';

const TABLE = 'extraction_candidates';

/**
 * Idempotent upsert keyed on call_id — a re-run replaces every payload column. A fresh
 * clean extraction is the ONLY path that resets the pii-scan latch: the conflict branch
 * puts `pii_scan_status` back to 'pending', clears the failure marker columns, and
 * clears a soft delete, because the new candidate is new content that the scan stage
 * must (re-)verify from scratch. A HARD-deleted row is never updated at all —
 * retention's hard delete is final and extraction must not repopulate it: the guarded
 * conflict matches zero rows and this throws instead of silently succeeding (same
 * pattern as upsertCleanTranscript).
 */
export async function upsertExtractionCandidate(
  pool: Pool,
  input: ExtractionCandidateInsert,
): Promise<ExtractionCandidateRow> {
  const v = parseOrThrow(TABLE, extractionCandidateInsertSchema, input);
  const rows = await query<ExtractionCandidateRow>(
    pool,
    `INSERT INTO extraction_candidates (
       call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
       location_in_home, access_or_scheduling_notes, prior_attempts, urgency, concerns,
       sentiment, acquisition_source, competitor_mentions, schema_version, prompt_version, model_id)
     VALUES (
       $1, $2, $3, $4, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6::jsonb, '[]'::jsonb),
       $7, $8, $9, $10, COALESCE($11::jsonb, '[]'::jsonb),
       $12, $13, COALESCE($14::jsonb, '[]'::jsonb), $15, $16, $17)
     ON CONFLICT (call_id) DO UPDATE SET
       call_intent = EXCLUDED.call_intent,
       service_category = EXCLUDED.service_category,
       problem_statement = EXCLUDED.problem_statement,
       symptoms = EXCLUDED.symptoms,
       customer_language = EXCLUDED.customer_language,
       location_in_home = EXCLUDED.location_in_home,
       access_or_scheduling_notes = EXCLUDED.access_or_scheduling_notes,
       prior_attempts = EXCLUDED.prior_attempts,
       urgency = EXCLUDED.urgency,
       concerns = EXCLUDED.concerns,
       sentiment = EXCLUDED.sentiment,
       acquisition_source = EXCLUDED.acquisition_source,
       competitor_mentions = EXCLUDED.competitor_mentions,
       schema_version = EXCLUDED.schema_version,
       prompt_version = EXCLUDED.prompt_version,
       model_id = EXCLUDED.model_id,
       pii_scan_status = 'pending',
       pii_scan_failure_kind = NULL,
       pii_scan_failed_at = NULL,
       pii_scan_counts = NULL,
       soft_deleted_at = NULL
     WHERE extraction_candidates.hard_deleted_at IS NULL
     RETURNING *`,
    [
      v.callId,
      v.callIntent,
      v.serviceCategory,
      v.problemStatement ?? null,
      toJsonParam(v.symptoms),
      toJsonParam(v.customerLanguage),
      v.locationInHome ?? null,
      v.accessOrSchedulingNotes ?? null,
      v.priorAttempts ?? null,
      v.urgency,
      toJsonParam(v.concerns),
      v.sentiment,
      v.acquisitionSource ?? null,
      toJsonParam(v.competitorMentions),
      v.schemaVersion,
      v.promptVersion,
      v.modelId,
    ],
  );
  if (rows.length === 0) {
    throw new DalError(
      DAL_QUERY_FAILED,
      `${DAL_QUERY_FAILED}: ${TABLE} row is hard-deleted; extraction may not repopulate it (retention conflict)`,
      { table: TABLE, call_id: v.callId },
    );
  }
  return parseOrThrow(TABLE, extractionCandidateRowSchema, rows[0]);
}

export async function getExtractionCandidate(
  pool: Pool,
  callId: string,
): Promise<ExtractionCandidateRow | undefined> {
  const rows = await query<ExtractionCandidateRow>(
    pool,
    `SELECT * FROM extraction_candidates
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, extractionCandidateRowSchema, rows[0]) : undefined;
}

/**
 * Fail the verbatim-pii-scan for a candidate: ONE atomic UPDATE scrubs the verbatim
 * `customer_language` phrases to `[]` and stamps status/kind/failed_at/counts, so no
 * crash window exists where the phrases survive a recorded failure. The `failure`
 * payload is validated (numeric-only by construction — see piiScanFailureSchema)
 * BEFORE any SQL runs.
 *
 * May overwrite 'pending' OR 'passed': a deny-list change can make a previously passed
 * row unsafe on re-scan, and failing must always win. Never touches a soft/hard-deleted
 * row; throws when zero rows match (missing or deleted).
 */
export async function markPiiScanFailed(
  pool: Pool,
  callId: string,
  failure: PiiScanFailure,
): Promise<ExtractionCandidateRow> {
  const v = parseOrThrow(TABLE, piiScanFailureSchema, failure);
  const metadata =
    v.kind === 'residual_pii'
      ? v.counts
      : v.kind === 'tokened_phrase'
        ? { dropped_count: v.dropped_count }
        : { mismatch_count: v.mismatch_count, phrase_count: v.phrase_count };
  const rows = await query<ExtractionCandidateRow>(
    pool,
    `UPDATE extraction_candidates SET
       customer_language = '[]'::jsonb,
       pii_scan_status = 'failed',
       pii_scan_failed_at = now(),
       pii_scan_failure_kind = $2,
       pii_scan_counts = $3::jsonb
     WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL
     RETURNING *`,
    [callId, v.kind, toJsonParam(metadata)],
  );
  if (rows.length === 0) {
    throw new DalError(
      DAL_QUERY_FAILED,
      `${DAL_QUERY_FAILED}: ${TABLE} row missing or deleted; cannot mark pii scan failed`,
      { table: TABLE, call_id: callId },
    );
  }
  return parseOrThrow(TABLE, extractionCandidateRowSchema, rows[0]);
}

/**
 * Pass the verbatim-pii-scan — but ONLY from 'pending'. The failed marker is a ONE-WAY
 * privacy latch: once a candidate failed, no pass (however racy or replayed) may
 * un-fail it; only a fresh clean upsert resets the latch. Returns the updated row, or
 * `undefined` when zero rows matched (already failed/passed, deleted, or missing) so
 * the caller can re-read and decide.
 */
export async function markPiiScanPassed(
  pool: Pool,
  callId: string,
): Promise<ExtractionCandidateRow | undefined> {
  const rows = await query<ExtractionCandidateRow>(
    pool,
    `UPDATE extraction_candidates SET pii_scan_status = 'passed'
      WHERE call_id = $1 AND pii_scan_status = 'pending'
        AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL
      RETURNING *`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, extractionCandidateRowSchema, rows[0]) : undefined;
}

/**
 * Soft-delete the active candidate row. Same hard-delete guard semantics as the other
 * purgeable repos — never mutates a retention-final row. Idempotent; a missing or
 * already-deleted row is a no-op.
 */
export async function softDeleteExtractionCandidate(pool: Pool, callId: string): Promise<void> {
  await query(
    pool,
    `UPDATE extraction_candidates
        SET soft_deleted_at = now()
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
}

/**
 * True iff retention has HARD-deleted this call's extraction candidate. The extract
 * stage preflights on this before persisting a new candidate (mirrors
 * hasHardDeletedCleanTranscript).
 */
export async function hasHardDeletedExtractionCandidate(
  pool: Pool,
  callId: string,
): Promise<boolean> {
  const rows = await query(
    pool,
    `SELECT 1 AS present FROM extraction_candidates
      WHERE call_id = $1 AND hard_deleted_at IS NOT NULL`,
    [callId],
  );
  return rows.length > 0;
}
