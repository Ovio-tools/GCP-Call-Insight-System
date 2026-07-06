import type { Pool } from 'pg';
import { query } from '../db/sql.js';
import { getCallState } from '../db/repositories/call-state-repo.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { getStructuredKnowledge } from '../db/repositories/structured-knowledge-repo.js';
import { getLatestClassificationBucket } from '../pipeline/classify/classification-marker.js';
import { validateRedactedInputSafe } from '../evaluation/pii-gate.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../evaluation/version.js';

/**
 * The side-by-side human-review report for the sample-validation harness (Task 11.1).
 *
 * Built ENTIRELY from de-identified stores — `call_state`, `clean_transcripts`,
 * `structured_knowledge`, the classify `processing_log`, and `review_queue`. It NEVER reads
 * `raw_transcripts` or `token_vault`, so raw transcript text and vault values cannot enter the
 * report by construction. `sentiment` is internal-only (ADR) and is deliberately excluded.
 *
 * As defense-in-depth over already-redaction-clean text, every free-text field is re-screened by
 * the residual-PII gate (counts-only, over the deny list): a hit WITHHOLDS the offending text and
 * records a sanitized flag + category keys, so no clear PII can leak even if upstream redaction
 * missed something.
 */

/** The de-identified extracted record shown in the report — the durable KB fields, never sentiment. */
export interface SampleReportExtractRecord {
  call_intent: string;
  service_category: string;
  urgency: string;
  problem_statement: string | null;
  symptoms: string[];
  customer_language: string[];
  concerns: string[];
  competitor_mentions: string[];
  acquisition_source: string | null;
  location_in_home: string | null;
  access_or_scheduling_notes: string | null;
  prior_attempts: string | null;
}

export interface SampleReportValidation {
  generated_at: string;
  eval_set_version: number;
  pii_gate_version: number;
  redacted_text_present: boolean;
  extracted_record_present: boolean;
  /** True when the residual-PII gate tripped on any report text (that text is then withheld). */
  pii_guard_tripped: boolean;
  /** Category keys of any residual hit — NEVER the values or the surrounding text. */
  pii_guard_categories: string[];
}

export interface SampleReportEntry {
  call_id: string;
  pipeline_status: string;
  current_stage: string;
  drop_reason: string | null;
  classifier_bucket: string | null;
  hold_reason: string | null;
  redacted_text: string | null;
  extracted_record: SampleReportExtractRecord | null;
  prompt_version: string | null;
  model_id: string | null;
  schema_version: number | null;
  validation: SampleReportValidation;
}

export interface BuildReportOptions {
  denyTerms: readonly string[];
  /** Injectable clock for a deterministic `generated_at` in tests. */
  now?: Date;
}

async function activeHoldReason(pool: Pool, callId: string): Promise<string | null> {
  const rows = await query<{ held_reason: string }>(
    pool,
    `SELECT held_reason FROM review_queue
      WHERE call_id = $1 AND status IN ('open', 'in_review')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [callId],
  );
  return rows[0]?.held_reason ?? null;
}

function screen(
  text: string,
  denyTerms: readonly string[],
): { safe: boolean; categories: string[] } {
  const gate = validateRedactedInputSafe(text, denyTerms);
  return gate.safe
    ? { safe: true, categories: [] }
    : { safe: false, categories: Object.keys(gate.counts) };
}

/** Assemble one PII-free side-by-side report entry for a processed call. */
export async function buildSampleReport(
  pool: Pool,
  callId: string,
  options: BuildReportOptions,
): Promise<SampleReportEntry> {
  const denyTerms = options.denyTerms;
  const now = options.now ?? new Date();

  const callState = await getCallState(pool, callId);
  if (callState === undefined) {
    throw new Error(`buildSampleReport: no call_state for ${callId}`);
  }

  const clean = await getCleanTranscript(pool, callId);
  const knowledge = await getStructuredKnowledge(pool, callId);
  const bucket = await getLatestClassificationBucket(pool, callId);
  const holdReason = await activeHoldReason(pool, callId);

  const guardCategories = new Set<string>();

  // Redacted text: screen and withhold on a residual hit.
  let redactedText: string | null = clean?.redacted_text ?? null;
  if (redactedText !== null) {
    const r = screen(redactedText, denyTerms);
    if (!r.safe) {
      redactedText = null;
      r.categories.forEach((c) => guardCategories.add(c));
    }
  }

  // Extracted record: keep the controlled enums; screen the free-text fields together and withhold
  // them on a residual hit (the enums are safe controlled vocabularies).
  let extracted: SampleReportExtractRecord | null = null;
  if (knowledge !== undefined) {
    const freeText = [
      knowledge.problem_statement ?? '',
      ...knowledge.symptoms,
      ...knowledge.customer_language,
      ...knowledge.concerns,
      ...knowledge.competitor_mentions,
      knowledge.acquisition_source ?? '',
      knowledge.location_in_home ?? '',
      knowledge.access_or_scheduling_notes ?? '',
      knowledge.prior_attempts ?? '',
    ].join('\n');
    const r = screen(freeText, denyTerms);
    const withholdFreeText = !r.safe;
    if (withholdFreeText) r.categories.forEach((c) => guardCategories.add(c));

    extracted = {
      call_intent: knowledge.call_intent,
      service_category: knowledge.service_category,
      urgency: knowledge.urgency,
      problem_statement: withholdFreeText ? null : knowledge.problem_statement,
      symptoms: withholdFreeText ? [] : knowledge.symptoms,
      customer_language: withholdFreeText ? [] : knowledge.customer_language,
      concerns: withholdFreeText ? [] : knowledge.concerns,
      competitor_mentions: withholdFreeText ? [] : knowledge.competitor_mentions,
      acquisition_source: withholdFreeText ? null : knowledge.acquisition_source,
      location_in_home: withholdFreeText ? null : knowledge.location_in_home,
      access_or_scheduling_notes: withholdFreeText ? null : knowledge.access_or_scheduling_notes,
      prior_attempts: withholdFreeText ? null : knowledge.prior_attempts,
    };
  }

  return {
    call_id: callId,
    pipeline_status: callState.status,
    current_stage: callState.current_stage,
    drop_reason: callState.drop_reason,
    classifier_bucket: bucket ?? null,
    hold_reason: holdReason,
    redacted_text: redactedText,
    extracted_record: extracted,
    prompt_version: knowledge?.prompt_version ?? null,
    model_id: knowledge?.model_id ?? null,
    schema_version: knowledge?.schema_version ?? null,
    validation: {
      generated_at: now.toISOString(),
      eval_set_version: EVAL_SET_VERSION,
      pii_gate_version: PII_GATE_VERSION,
      redacted_text_present: redactedText !== null,
      extracted_record_present: extracted !== null,
      pii_guard_tripped: guardCategories.size > 0,
      pii_guard_categories: [...guardCategories].sort(),
    },
  };
}
