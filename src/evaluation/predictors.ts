import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import {
  type ClassifyModelClient,
  type ExtractModelClient,
  CLASSIFY_OUTPUT_FORMAT_JSON,
  EXTRACT_OUTPUT_FORMAT_JSON,
} from '../anthropic/client.js';
import {
  type ModelRates,
  estimateCostUsd,
  estimatePayloadTokens,
  reserveModelBudget,
  settleModelUsage,
} from '../model/cost.js';
import { recordModelInvocation } from '../db/repositories/model-invocations-repo.js';
import { handleModelError, recordStageAlert } from '../pipeline/model-stage-shared.js';
import {
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserMessage,
} from '../pipeline/classify/prompt.js';
import {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserMessage,
} from '../pipeline/extract/prompt.js';
import { parseClassification } from '../pipeline/classify/parse.js';
import { parseExtraction } from '../pipeline/extract/parse.js';
import type { LabeledExampleRow } from '../db/schemas/labeled-examples.js';
import type {
  ClassifyPredictor,
  ClassifyPrediction,
  ExtractPredictor,
  ExtractPrediction,
  PredictResult,
} from './run-evaluation.js';

/**
 * Live predictors for the evaluation runner (Task 6.3). Each wraps the Anthropic client + the
 * pipeline parse module and is FULLY accounted: it honors the stage kill switch and the shared
 * `src/model/cost.ts` reservation/cap (refusing with `killed`/`cost_capped` rather than crashing),
 * and records a `model_invocations` row with stage `evaluation-classify` / `evaluation-extract`.
 * Tests inject stub predictors and never reach this module; this is the ONLY code path that spends.
 *
 * Control flow mirrors the classify/extract stage handlers: kill switch → build request → reserve →
 * call → parse → record invocation + settle → return a prediction. A thrown model error is routed
 * through {@link handleModelError} (release/keep + deduped alert) and surfaced as an `error`
 * prediction (a per-example failure), never a crash that aborts the whole run.
 */

export interface ClassifyPredictorDeps {
  pool: Pool;
  config: Config;
  getModel: () => ClassifyModelClient;
  logger: Logger;
  clock?: { now(): number };
}

export interface ExtractPredictorDeps {
  pool: Pool;
  config: Config;
  getModel: () => ExtractModelClient;
  logger: Logger;
  clock?: { now(): number };
}

const CLASSIFY_STAGE = 'evaluation-classify';
const EXTRACT_STAGE = 'evaluation-extract';

export function createClassifyPredictor(deps: ClassifyPredictorDeps): ClassifyPredictor {
  const nowMs = (): number => (deps.clock ? deps.clock.now() : Date.now());
  const rates: ModelRates = {
    inputUsdPerMtok: deps.config.CLASSIFY_COST_USD_PER_MTOK_INPUT,
    outputUsdPerMtok: deps.config.CLASSIFY_COST_USD_PER_MTOK_OUTPUT,
  };

  return async (ex: LabeledExampleRow): Promise<PredictResult<ClassifyPrediction>> => {
    if (!deps.config.CLASSIFY_ENABLED) return { status: 'killed' };

    const system = CLASSIFY_SYSTEM_PROMPT;
    const userText = buildClassifyUserMessage(ex.redacted_input);
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
    const reservation = await reserveModelBudget(deps.pool, {
      config: deps.config,
      now: new Date(nowMs()),
      requestCostUsd,
    });
    if (reservation === null) {
      await recordStageAlert(
        deps.pool,
        ex.call_id,
        CLASSIFY_STAGE,
        deps.config,
        'MODEL_COST_CAP_EXCEEDED',
        'paused',
      );
      return { status: 'cost_capped' };
    }

    let result;
    try {
      result = await deps.getModel().classify({ system, userText });
    } catch (err) {
      await handleModelError(
        deps.pool,
        ex.call_id,
        CLASSIFY_STAGE,
        deps.config,
        reservation,
        err,
        deps.logger,
      );
      return { status: 'error' };
    }

    const parsed = parseClassification({ text: result.text, stopReason: result.stopReason });
    const outcome = parsed.ok && result.usagePresent ? 'success' : 'malformed_response';
    await recordModelInvocation(deps.pool, {
      callId: ex.call_id,
      stage: CLASSIFY_STAGE,
      modelId: deps.config.CLASSIFY_MODEL_ID,
      promptVersion: CLASSIFY_PROMPT_VERSION,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outcome,
    });
    if (result.usagePresent) {
      await settleModelUsage(deps.pool, reservation, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        rates,
      });
    }
    if (!parsed.ok || !result.usagePresent) return { status: 'malformed' };
    return { status: 'ok', value: { bucket: parsed.bucket } };
  };
}

export function createExtractPredictor(deps: ExtractPredictorDeps): ExtractPredictor {
  const nowMs = (): number => (deps.clock ? deps.clock.now() : Date.now());
  const rates: ModelRates = {
    inputUsdPerMtok: deps.config.EXTRACT_COST_USD_PER_MTOK_INPUT,
    outputUsdPerMtok: deps.config.EXTRACT_COST_USD_PER_MTOK_OUTPUT,
  };

  return async (ex: LabeledExampleRow): Promise<PredictResult<ExtractPrediction>> => {
    if (!deps.config.EXTRACT_ENABLED) return { status: 'killed' };

    const system = EXTRACT_SYSTEM_PROMPT;
    const userText = buildExtractUserMessage(ex.redacted_input);
    const reservedInputTokens = Math.max(
      deps.config.EXTRACT_INPUT_TOKENS_CEILING,
      estimatePayloadTokens({
        system,
        userText,
        outputFormatJson: EXTRACT_OUTPUT_FORMAT_JSON,
        overheadTokens: deps.config.EXTRACT_RESERVATION_OVERHEAD_TOKENS,
      }),
    );
    const requestCostUsd = estimateCostUsd({
      inputTokens: reservedInputTokens,
      outputTokens: deps.config.EXTRACT_MAX_TOKENS,
      rates,
    });
    const reservation = await reserveModelBudget(deps.pool, {
      config: deps.config,
      now: new Date(nowMs()),
      requestCostUsd,
    });
    if (reservation === null) {
      await recordStageAlert(
        deps.pool,
        ex.call_id,
        EXTRACT_STAGE,
        deps.config,
        'MODEL_COST_CAP_EXCEEDED',
        'paused',
      );
      return { status: 'cost_capped' };
    }

    let result;
    try {
      result = await deps.getModel().extract({ system, userText });
    } catch (err) {
      await handleModelError(
        deps.pool,
        ex.call_id,
        EXTRACT_STAGE,
        deps.config,
        reservation,
        err,
        deps.logger,
      );
      return { status: 'error' };
    }

    const parsed = parseExtraction({ text: result.text, stopReason: result.stopReason });
    const outcome = parsed.ok && result.usagePresent ? 'success' : 'malformed_response';
    await recordModelInvocation(deps.pool, {
      callId: ex.call_id,
      stage: EXTRACT_STAGE,
      modelId: deps.config.EXTRACT_MODEL_ID,
      promptVersion: EXTRACT_PROMPT_VERSION,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      outcome,
    });
    if (result.usagePresent) {
      await settleModelUsage(deps.pool, reservation, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        rates,
      });
    }
    if (!parsed.ok || !result.usagePresent) return { status: 'malformed' };
    return {
      status: 'ok',
      value: {
        call_intent: parsed.record.call_intent,
        service_category: parsed.record.service_category,
        urgency: parsed.record.urgency,
        sentiment: parsed.record.sentiment,
      },
    };
  };
}
