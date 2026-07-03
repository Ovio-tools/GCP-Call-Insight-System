import type { Config } from '../../config/schema.js';
import { type ClassifyModelClient, CLASSIFY_OUTPUT_FORMAT_JSON } from '../../anthropic/client.js';
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
import type { Clock } from '../fetch-transcript.js';
import {
  emitCostWarningIfReached,
  handleModelError,
  parkStageDisabled,
  recordStageAlert,
} from '../model-stage-shared.js';
import {
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserMessage,
} from './prompt.js';
import { parseClassification } from './parse.js';
import type { StageContext, StageHandler, StageResult } from '../stages.js';

export interface ClassifyHandlerDeps {
  /** Lazy thunk invoked only AFTER the kill-switch, transcript, and cost-cap gates pass. */
  getModel: () => ClassifyModelClient;
  config: Config;
  /** Injected time (UTC-day derivation for the cost cap); mirrors fetch-transcript. */
  clock?: Clock;
}

/** The detail marker the kill-switch parks a call with, in the processing_log. */
const CLASSIFY_DISABLED_REASON = 'classify_disabled';

/**
 * The `classify` stage handler (Task 5.1, Haiku). Ties together the cost guardrail, the
 * Anthropic wrapper, and the prompt/parse modules. Control flow order is load-bearing:
 * kill-switch → load transcript → build request → reserve budget → call model → parse →
 * record invocation + settle spend → route.
 *
 * Privacy: only the redacted text crosses to Anthropic. No transcript content, no model
 * `reason`, and no raw SDK error message ever reaches a log line, alert, or failure snapshot.
 */
export function createClassifyHandler(deps: ClassifyHandlerDeps): StageHandler {
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger, pool } = ctx;

    // 1. Kill switch. No model construction, no transcript load, no retry — just an
    //    idempotent park. The Task 9 requeue script resumes these after re-enabling.
    if (!deps.config.CLASSIFY_ENABLED) {
      await parkStageDisabled(pool, callId, 'classify', CLASSIFY_DISABLED_REASON);
      logger.info({ stage }, 'classify disabled — parked (deferred)');
      return { action: 'defer' };
    }

    // 2. Load the clean transcript. Absence is an invariant break (redact advanced without
    //    storing output), THROWN before the cost cap so a broken 4.1 contract never surfaces
    //    as a spurious cost_cap_held. The runner wraps this in PipelineStageError → retry →
    //    dead-letter. Do NOT call Anthropic; do NOT mark complete.
    const row = await getCleanTranscript(pool, callId);
    if (!row) {
      throw new Error(
        `clean_transcripts row for ${callId} is missing at classify — redact advanced without storing output`,
      );
    }

    // 3. Build the request. The outbound payload is ONLY these two strings.
    const system = CLASSIFY_SYSTEM_PROMPT;
    const userText = buildClassifyUserMessage(row.redacted_text);

    // 4. Cost-cap reserve (atomic). Reserve against max(ceiling, payload-aware estimate) so
    //    a huge transcript reserves its true upper bound, not just the floor.
    const rates: ModelRates = {
      inputUsdPerMtok: deps.config.CLASSIFY_COST_USD_PER_MTOK_INPUT,
      outputUsdPerMtok: deps.config.CLASSIFY_COST_USD_PER_MTOK_OUTPUT,
    };
    const reservedInputTokens = Math.max(
      deps.config.CLASSIFY_INPUT_TOKENS_CEILING,
      estimatePayloadTokens({
        system,
        userText,
        outputFormatJson: CLASSIFY_OUTPUT_FORMAT_JSON,
        overheadTokens: deps.config.CLASSIFY_RESERVATION_OVERHEAD_TOKENS,
      }),
    );
    const requestCostUsd = estimateCostUsd({
      inputTokens: reservedInputTokens,
      outputTokens: deps.config.CLASSIFY_MAX_TOKENS,
      rates,
    });
    const reservation = await reserveModelBudget(pool, {
      config: deps.config,
      now: new Date(now()),
      requestCostUsd,
    });
    if (reservation === null) {
      await recordStageAlert(pool, callId, stage, deps.config, 'MODEL_COST_CAP_EXCEEDED', 'paused');
      logger.info({ stage }, 'daily model cost cap reached — holding cost_cap_held');
      return { action: 'hold', reason: 'cost_cap_held', errorCode: 'MODEL_COST_CAP_EXCEEDED' };
    }

    // 4b. Advisory cost-warning alert (Task 7.2). Non-blocking and best-effort: emitted at most
    //     once per UTC day when estimated spend crosses the warning threshold; it never holds,
    //     retries, or converts the call. Runs AFTER the cost-cap gate (the hard cap supersedes).
    await emitCostWarningIfReached(pool, callId, stage, deps.config, reservation, logger);

    // 5. Call the model. try/catch wraps BOTH getModel() and classify(). On any thrown error
    //    the reservation is released/kept per the billing disposition, then rethrown.
    let result;
    try {
      const model = deps.getModel();
      result = await model.classify({ system, userText });
    } catch (err) {
      await handleModelError(pool, callId, stage, deps.config, reservation, err, logger);
      throw err;
    }

    // 6. Parse.
    const parsed = parseClassification({ text: result.text, stopReason: result.stopReason });

    // 7. Record invocation before routing (record-before-route), always with the real
    //    (possibly 0) tokens. Settlement, however, is gated on usage being present.
    //    Accepted seam: a crash between this invocation insert and the routing/settle write
    //    can duplicate the model_invocations row on retry — accepted per the repo's
    //    at-least-once idempotency stance (matches the plan's Task 7 note).
    const outcome = parsed.ok && result.usagePresent ? 'success' : 'malformed_response';
    await recordModelInvocation(pool, {
      callId,
      stage: 'classify',
      modelId: deps.config.CLASSIFY_MODEL_ID,
      promptVersion: CLASSIFY_PROMPT_VERSION,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outcome,
    });
    if (result.usagePresent) {
      await settleModelUsage(pool, reservation, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        rates,
      });
    }
    // else: usage missing — KEEP the reservation as the conservative spend estimate.
    // We know a request was sent and billed but not the token count; settling to (0,0) would
    // release it and undercount the daily cap (violating the never-undercount guarantee).
    // Do NOT releaseModelReservation here either (release also zeroes it).

    // 8. Route. A valid parse WITH usage present is required to trust the answer; a missing
    //    usage block (even with a valid parse) is treated as a malformed response.
    const isMalformed = !parsed.ok || !result.usagePresent;
    if (isMalformed) {
      const failure = createFailure('MODEL_MALFORMED_RESPONSE', {
        processingState: 'continuing',
        context: { call_id: callId, stage, environment: deps.config.NODE_ENV },
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
        'classify produced malformed model output — holding',
      );
      return {
        action: 'hold',
        reason: 'malformed_model_output',
        errorCode: 'MODEL_MALFORMED_RESPONSE',
        detail: {
          ...(result.usagePresent ? {} : { usage_missing: true }),
          ...(parsed.ok ? {} : { parse_failure: parsed.failure }),
        },
      };
    }

    // parsed.ok && result.usagePresent — route by bucket.
    logger.info(
      {
        stage,
        bucket: parsed.bucket,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      },
      'classify routed',
    );
    switch (parsed.bucket) {
      case 'customer':
        return { action: 'continue', detail: { bucket: 'customer' } };
      case 'non-customer':
        return {
          action: 'drop',
          reason: 'classified_non_customer',
          detail: { bucket: 'non-customer' },
        };
      case 'spam':
        // A classification outcome, not a failure — no errorCode.
        return { action: 'hold', reason: 'classified_spam', detail: { bucket: 'spam' } };
      case 'held':
        // The classifier itself was uncertain — no errorCode.
        return { action: 'hold', reason: 'classifier_uncertain', detail: { bucket: 'held' } };
    }
  };
}

/** Exported so the Task 9 requeue script and tests share the marker string. */
export { CLASSIFY_DISABLED_REASON };
