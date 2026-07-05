import type { Config } from '../../config/schema.js';
import { type ExtractModelClient, EXTRACT_OUTPUT_FORMAT_JSON } from '../../anthropic/client.js';
import {
  type ModelRates,
  estimateCostUsd,
  estimatePayloadTokens,
  reserveModelBudget,
  settleModelUsage,
} from '../../model/cost.js';
import { createFailure, dedupKey, failureSnapshot } from '../../failure-model/index.js';
import { recordAlert } from '../../db/repositories/alert-events-repo.js';
import { getCleanTranscript } from '../../db/repositories/clean-transcripts-repo.js';
import { recordModelInvocation } from '../../db/repositories/model-invocations-repo.js';
import {
  hasHardDeletedExtractionCandidate,
  upsertExtractionCandidate,
} from '../../db/repositories/extraction-candidates-repo.js';
import { loadDenyList } from '../../redaction/deny-list.js';
import type { Clock } from '../fetch-transcript.js';
import {
  emitCostWarningIfReached,
  handleModelError,
  parkStageDisabled,
  recordStageAlert,
  recordVerbatimPiiDetectedAlertResilient,
} from '../model-stage-shared.js';
import { getLatestClassificationBucket } from '../classify/classification-marker.js';
import { EXTRACT_PROMPT_VERSION, EXTRACT_SCHEMA_VERSION, EXTRACT_SYSTEM_PROMPT } from './prompt.js';
import { buildExtractUserMessage } from './prompt.js';
import { parseExtraction } from './parse.js';
import { emergencyRule, scanPhrasesForResidual, tokenGate, verbatimGate } from './gates.js';
import type { StageContext, StageHandler, StageResult } from '../stages.js';

/** The detail marker the kill-switch parks a call with, in the processing_log. */
export const EXTRACT_DISABLED_REASON = 'extract_disabled';

export interface ExtractHandlerDeps {
  /** Lazy thunk invoked only AFTER the kill-switch, retention, classification, transcript,
   * and cost-cap gates pass. */
  getModel: () => ExtractModelClient;
  config: Config;
  /** Injected time (UTC-day derivation for the cost cap); mirrors classify. */
  clock?: Clock;
  /** Deny terms; when absent they are loaded ONCE at construction from config (below). */
  denyTerms?: readonly string[];
}

/**
 * The `extract` stage handler (Task 5.2, Sonnet). Ties the cost guardrail, the Anthropic
 * wrapper, and the prompt/parse/gates modules into the fixed ordered flow: kill-switch →
 * retention preflight → classification guard → load input → reserve → call model → parse →
 * record invocation + settle → malformed route → residual-PII gate → verbatim gate → token
 * gate → emergency rule → persist → route. Mirrors src/pipeline/classify/handler.ts.
 *
 * Privacy: only the redacted text crosses to Anthropic. No transcript content, no model
 * `reason`, no raw SDK error message, and NO extracted record field (customer_language
 * phrases, problem_statement, …) ever reaches a log line, alert snapshot, processing_log
 * detail, or review_queue row. Gates and alerts carry only counts / booleans / constant ids.
 */
export function createExtractHandler(deps: ExtractHandlerDeps): StageHandler {
  // A bad deny-list config fails CONSTRUCTION (ConfigError), never a per-call retry loop.
  const denyTerms = deps.denyTerms ?? loadDenyList(deps.config.REDACTION_DENY_LIST_PATH);
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger, pool } = ctx;
    const config = deps.config;

    // 1. Kill switch. No model construction, no reads, no retry — just an idempotent park.
    //    The Task 9 requeue script resumes these after re-enabling.
    if (!config.EXTRACT_ENABLED) {
      await parkStageDisabled(pool, callId, 'extract', EXTRACT_DISABLED_REASON);
      logger.info({ stage }, 'extract disabled — parked (deferred)');
      return { action: 'defer' };
    }

    // 2. Retention preflight. Never re-spend model budget repopulating a hard-deleted
    //    candidate — retention's hard delete is final. Thrown → retry → dead-letter.
    if (await hasHardDeletedExtractionCandidate(pool, callId)) {
      throw new Error(
        `extraction_candidates row for ${callId} is hard-deleted — extract must not repopulate it (retention conflict)`,
      );
    }

    // 3. Classification guard. Runs BEFORE loading the transcript / any model spend: extract
    //    only runs for a `customer` call. A genuine mismatch is an invariant break (classify
    //    advanced a non-customer/missing marker into extract) → retry → dead-letter, the
    //    intended diagnosable outcome (same rationale as classify's missing-transcript throw).
    //    Do NOT log the transcript.
    const bucket = await getLatestClassificationBucket(pool, callId);
    if (bucket !== 'customer') {
      throw new Error(
        `extract invariant: expected classify bucket customer, got ${bucket ?? 'missing'}`,
      );
    }

    // 4. Load input. Absence is an invariant break (redact/classify advanced without stored
    //    output), THROWN before the cost cap so a broken upstream never surfaces as a spurious
    //    cost_cap_held. The outbound payload is ONLY these two strings; raw transcript / vault /
    //    recordings are never touched.
    const row = await getCleanTranscript(pool, callId);
    if (!row) {
      throw new Error(
        `clean_transcripts row for ${callId} is missing at extract — upstream advanced without storing output`,
      );
    }
    const system = EXTRACT_SYSTEM_PROMPT;
    const userText = buildExtractUserMessage(row.redacted_text);

    // 5. Cost-cap reserve (atomic). Reserve against max(ceiling, payload-aware estimate) so a
    //    huge transcript reserves its true upper bound, not just the floor.
    const rates: ModelRates = {
      inputUsdPerMtok: config.EXTRACT_COST_USD_PER_MTOK_INPUT,
      outputUsdPerMtok: config.EXTRACT_COST_USD_PER_MTOK_OUTPUT,
    };
    const reservedInputTokens = Math.max(
      config.EXTRACT_INPUT_TOKENS_CEILING,
      estimatePayloadTokens({
        system,
        userText,
        outputFormatJson: EXTRACT_OUTPUT_FORMAT_JSON,
        overheadTokens: config.EXTRACT_RESERVATION_OVERHEAD_TOKENS,
      }),
    );
    const requestCostUsd = estimateCostUsd({
      inputTokens: reservedInputTokens,
      outputTokens: config.EXTRACT_MAX_TOKENS,
      rates,
    });
    const reservation = await reserveModelBudget(pool, {
      config,
      now: new Date(now()),
      requestCostUsd,
    });
    if (reservation === null) {
      await recordStageAlert(pool, callId, stage, config, 'MODEL_COST_CAP_EXCEEDED', 'paused');
      logger.info({ stage }, 'daily model cost cap reached — holding cost_cap_held');
      return { action: 'hold', reason: 'cost_cap_held', errorCode: 'MODEL_COST_CAP_EXCEEDED' };
    }

    // 5b. Advisory cost-warning alert (Task 7.2). Non-blocking and best-effort: emitted at most
    //     once per UTC day when estimated spend crosses the warning threshold; it never holds,
    //     retries, or converts the call. Runs AFTER the cost-cap gate (the hard cap supersedes).
    await emitCostWarningIfReached(pool, callId, stage, config, reservation, logger);

    // 6. Call the model. try/catch wraps BOTH getModel() and extract(). On any thrown error
    //    the reservation is released/kept per the billing disposition, then rethrown.
    let result;
    try {
      const model = deps.getModel();
      result = await model.extract({ system, userText });
    } catch (err) {
      await handleModelError(pool, callId, stage, config, reservation, err, logger);
      throw err;
    }

    // 7. Parse.
    const parsed = parseExtraction({ text: result.text, stopReason: result.stopReason });

    // 8. Record invocation before routing (record-before-route), always with the real
    //    (possibly 0) tokens. Settlement is gated on usage being present.
    const outcome = parsed.ok && result.usagePresent ? 'success' : 'malformed_response';
    await recordModelInvocation(pool, {
      callId,
      stage: 'extract',
      modelId: config.EXTRACT_MODEL_ID,
      promptVersion: EXTRACT_PROMPT_VERSION,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outcome,
    });

    // 9. Settle spend when usage is present; otherwise KEEP the reservation.
    if (result.usagePresent) {
      await settleModelUsage(pool, reservation, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        rates,
      });
    }
    // else: usage missing — KEEP the reservation as the conservative spend estimate. A request
    // was sent and billed but the token count is unreadable; settling to (0,0) would release it
    // and undercount the daily cap (never-undercount). Do NOT releaseModelReservation either.

    // 10. Malformed route. A valid parse WITH usage present is required to trust the answer; a
    //     missing usage block (even with a valid parse) is treated as malformed.
    //     DIVERGENCE FROM CLASSIFY: extract holds with reason `schema_invalid` (classify uses
    //     `malformed_model_output`) — Task 5.2 routes ALL extract model-output badness to
    //     `schema_invalid`. The alert shape (MODEL_MALFORMED_RESPONSE, continuing) is identical.
    if (!parsed.ok || !result.usagePresent) {
      const failure = createFailure('MODEL_MALFORMED_RESPONSE', {
        processingState: 'continuing',
        context: { call_id: callId, stage, environment: config.NODE_ENV },
      });
      await recordAlert(pool, {
        errorCode: failure.error_code,
        rootCauseCategory: failure.root_cause_category,
        severity: failure.severity,
        dedupKey: dedupKey(failure),
        failureSnapshot: {
          ...failureSnapshot(failure),
          call_id: callId,
          stage,
          ...(result.usagePresent ? {} : { usage_missing: true }),
          ...(parsed.ok ? {} : { parse_failure: parsed.failure }),
        },
      });
      logger.info(
        {
          stage,
          usage_present: result.usagePresent,
          ...(parsed.ok ? {} : { parse_failure: parsed.failure }),
        },
        'extract produced malformed model output — holding schema_invalid',
      );
      return {
        action: 'hold',
        reason: 'schema_invalid',
        errorCode: 'MODEL_MALFORMED_RESPONSE',
        detail: {
          ...(result.usagePresent ? {} : { usage_missing: true }),
          ...(parsed.ok ? {} : { parse_failure: parsed.failure }),
        },
      };
    }
    const record = parsed.record;

    // 11. Residual-PII gate — the FIRST content gate, before ANY persist. Runs BEFORE the
    //     verbatim gate so a fabricated phrase containing PII holds as a PII detection, not as
    //     output badness (PII precedence). The alert is resilient: its failure must not block
    //     or convert the hold. Persist NOTHING. Snapshot/detail carry COUNTS + category ids only.
    const scan = scanPhrasesForResidual(record.customer_language, denyTerms);
    if (scan.hit) {
      await recordVerbatimPiiDetectedAlertResilient(
        pool,
        callId,
        stage,
        config,
        scan.counts,
        logger,
      );
      logger.info(
        { stage, residual_categories: Object.keys(scan.counts) },
        'extract residual-PII hit in customer_language — holding residual_pii_detected',
      );
      return {
        action: 'hold',
        reason: 'residual_pii_detected',
        errorCode: 'VERBATIM_PII_DETECTED',
        detail: { residual_categories: Object.keys(scan.counts), counts: scan.counts },
      };
    }

    // 12. Verbatim gate — every phrase must appear (light-normalized) in the redacted text.
    //     A reconstructed/paraphrased phrase is output badness → schema_invalid. Persist NOTHING.
    const vb = verbatimGate(record.customer_language, row.redacted_text);
    if (!vb.ok) {
      await recordStageAlert(
        pool,
        callId,
        stage,
        config,
        'MODEL_MALFORMED_RESPONSE',
        'continuing',
        {
          gate: 'verbatim_mismatch',
          mismatch_count: vb.mismatchCount,
          phrase_count: vb.phraseCount,
        },
      );
      logger.info(
        { stage, gate: 'verbatim_mismatch', mismatch_count: vb.mismatchCount },
        'extract customer_language failed the verbatim gate — holding schema_invalid',
      );
      return {
        action: 'hold',
        reason: 'schema_invalid',
        errorCode: 'MODEL_MALFORMED_RESPONSE',
        detail: {
          gate: 'verbatim_mismatch',
          mismatch_count: vb.mismatchCount,
          phrase_count: vb.phraseCount,
        },
      };
    }

    // 13. Token gate — drop any phrase carrying a redaction token; keep the rest. COUNTS ONLY.
    const gated = tokenGate(record.customer_language);

    // 14. Deterministic emergency rule (urgency + hold + constant trigger ids).
    const decision = emergencyRule(record, row.redacted_text);

    // 15. Persist the de-identified candidate (idempotent upsert; resets pii_scan_status to
    //     'pending'). The record uses SNAKE_CASE keys; the insert schema uses CAMELCASE — mapped
    //     explicitly below. Persisted even when an emergency hold follows: the record is
    //     clean+validated, review resolves it, and the pipeline later resumes to scan/store
    //     without re-extracting.
    await upsertExtractionCandidate(pool, {
      callId,
      callIntent: record.call_intent,
      serviceCategory: record.service_category,
      problemStatement: record.problem_statement,
      symptoms: record.symptoms,
      customerLanguage: gated.phrases,
      locationInHome: record.location_in_home,
      accessOrSchedulingNotes: record.access_or_scheduling_notes,
      priorAttempts: record.prior_attempts,
      urgency: decision.urgency,
      concerns: record.concerns,
      sentiment: record.sentiment,
      acquisitionSource: record.acquisition_source,
      competitorMentions: record.competitor_mentions,
      schemaVersion: EXTRACT_SCHEMA_VERSION,
      promptVersion: EXTRACT_PROMPT_VERSION,
      modelId: config.EXTRACT_MODEL_ID,
    });

    // 16. Route. An emergency hold is a routing outcome (like classified_spam), NOT a failure:
    //     no errorCode, no alert — the review_queue row + its SLA is the signal.
    if (decision.hold) {
      logger.info(
        { stage, urgency: 'emergency', triggers: decision.triggers },
        'extract flagged emergency — holding emergency_review',
      );
      return {
        action: 'hold',
        reason: 'emergency_review',
        detail: { urgency: 'emergency', triggers: decision.triggers },
      };
    }
    logger.info(
      {
        stage,
        phrase_count: gated.phrases.length,
        tokened_phrases_dropped: gated.droppedCount,
        urgency: decision.urgency,
      },
      'extract completed — advancing',
    );
    return {
      action: 'continue',
      detail: {
        phrase_count: gated.phrases.length,
        tokened_phrases_dropped: gated.droppedCount,
        urgency: decision.urgency,
      },
    };
  };
}
