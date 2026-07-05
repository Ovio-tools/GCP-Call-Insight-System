import {
  getExtractionCandidate,
  markExtractionCandidateRetentionEligible,
} from '../db/repositories/extraction-candidates-repo.js';
import { upsertStructuredKnowledge } from '../db/repositories/structured-knowledge-repo.js';
import type { StageContext, StageHandler, StageResult } from './stages.js';

/**
 * The `store` stage handler (Task 5.3). Copies the verified extraction candidate into the
 * durable `structured_knowledge` store via the idempotent upsert keyed on call_id
 * (recording schema_version + prompt_version), then stamps the now-redundant staging
 * candidate retention-eligible. Returning `continue` lets the runner advance to
 * `mark-retention-eligible` (the final stage), which stamps the raw transcript + vault; the
 * call reaches `completed` ONLY after this store succeeds.
 *
 * Idempotent: `upsertStructuredKnowledge` is an ON CONFLICT (call_id) upsert, so a re-run
 * (or a crash-before-advance retry) overwrites the single row with the latest candidate
 * rather than duplicating. No model call, no external write, no feature flag — pure
 * persistence at the pipeline's own data layer.
 *
 * Invariants (fail loud → retry → dead-letter, the diagnosable outcome):
 * - a live candidate must exist (verbatim-pii-scan advanced past `store` without one is a
 *   break); and
 * - it must be `pii_scan_status='passed'` — defense in depth. verbatim-pii-scan only
 *   advances a candidate it has PASSED; a pending/failed candidate reaching `store` means
 *   the scan gate was bypassed, so the durable store must refuse it rather than persist an
 *   unverified record.
 *
 * Privacy: NO extracted field (customer_language phrases, problem_statement, …) ever
 * reaches a log line or the processing_log detail — only the safe version metadata.
 */
export const storeHandler: StageHandler = async (ctx: StageContext): Promise<StageResult> => {
  const { callId, stage, logger, pool } = ctx;

  const candidate = await getExtractionCandidate(pool, callId);
  if (!candidate) {
    throw new Error(
      `extraction_candidates row for ${callId} is missing at store — ` +
        `verbatim-pii-scan advanced without a live candidate (invariant break)`,
    );
  }
  if (candidate.pii_scan_status !== 'passed') {
    throw new Error(
      `extraction_candidates row for ${callId} reached store with pii_scan_status ` +
        `'${candidate.pii_scan_status}', expected 'passed' — the verbatim PII gate was ` +
        `bypassed; refusing to store an unverified record (invariant break)`,
    );
  }

  await upsertStructuredKnowledge(pool, {
    callId: candidate.call_id,
    callIntent: candidate.call_intent,
    serviceCategory: candidate.service_category,
    problemStatement: candidate.problem_statement,
    symptoms: candidate.symptoms,
    customerLanguage: candidate.customer_language,
    locationInHome: candidate.location_in_home,
    accessOrSchedulingNotes: candidate.access_or_scheduling_notes,
    priorAttempts: candidate.prior_attempts,
    urgency: candidate.urgency,
    concerns: candidate.concerns,
    sentiment: candidate.sentiment,
    acquisitionSource: candidate.acquisition_source,
    competitorMentions: candidate.competitor_mentions,
    schemaVersion: candidate.schema_version,
    promptVersion: candidate.prompt_version,
    modelId: candidate.model_id,
  });

  // The staging candidate is redundant now that its content is durable — retire it. Runs
  // AFTER the upsert so the candidate is never marked purgeable before it is copied.
  await markExtractionCandidateRetentionEligible(pool, callId);

  logger.info(
    {
      stage,
      schema_version: candidate.schema_version,
      prompt_version: candidate.prompt_version,
    },
    'store wrote structured_knowledge and retired the staging candidate — advancing',
  );
  return {
    action: 'continue',
    detail: {
      schema_version: candidate.schema_version,
      prompt_version: candidate.prompt_version,
    },
  };
};
