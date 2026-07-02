import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import {
  type ClassifyModelClient,
  CLASSIFY_OUTPUT_FORMAT_JSON,
  ModelApiError,
} from '../../anthropic/client.js';
import {
  type BudgetReservation,
  type ModelRates,
  estimateCostUsd,
  estimatePayloadTokens,
  releaseModelReservation,
  reserveModelBudget,
  settleModelUsage,
} from '../../model/cost.js';
import {
  type ErrorCode,
  type ProcessingState,
  createFailure,
  dedupKey,
} from '../../failure-model/index.js';
import { recordAlert } from '../../db/repositories/alert-events-repo.js';
import { getCleanTranscript } from '../../db/repositories/clean-transcripts-repo.js';
import { recordModelInvocation } from '../../db/repositories/model-invocations-repo.js';
import { appendLog } from '../../db/repositories/processing-log-repo.js';
import { query, withTransaction } from '../../db/sql.js';
import type { Clock } from '../fetch-transcript.js';
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
 * Record a deduped stage alert for a mapped model failure. Context is sanitized to
 * call_id/stage/environment only; the failureSnapshot mirrors fetch-transcript's shape and
 * NEVER carries transcript content, model reasons, or a raw SDK error message.
 */
async function recordStageAlert(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  code: ErrorCode,
  processingState: ProcessingState,
  extraSnapshot: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const failure = createFailure(code, {
    processingState,
    context: { call_id: callId, stage, environment: config.NODE_ENV },
  });
  await recordAlert(pool, {
    errorCode: failure.error_code,
    rootCauseCategory: failure.root_cause_category,
    severity: failure.severity,
    dedupKey: dedupKey(failure),
    failureSnapshot: { call_id: callId, stage, ...extraSnapshot },
  });
}

/**
 * Kill-switch park (atomically idempotent). Inside a transaction, takes an advisory xact
 * lock on `classify-disabled:${callId}` so two concurrent runs of the disabled handler
 * serialize, then appends ONE `deferred` processing_log row only if the LATEST classify row
 * isn't already the `classify_disabled` marker. Returns after committing.
 *
 * Parked calls are recovered by the Task 9 requeue script AFTER re-enabling CLASSIFY_ENABLED;
 * reconciliation does not rescue them (they were never lost, just deferred).
 */
async function parkDisabled(pool: Pool, callId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await query(client, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `classify-disabled:${callId}`,
    ]);
    // Is the LATEST classify processing_log row already the disabled marker? If so, this is a
    // re-run of an already-parked call — append nothing (idempotency).
    // The id DESC tie-break assumes distinct created_at per row (processing_log.id is a random
    // uuid, not monotonic); this holds because the park marker and any later genuine classify
    // log are always written in separate transactions, so their created_at differs.
    const rows = await query<{ reason: string | null }>(
      client,
      `SELECT detail->>'reason' AS reason
         FROM processing_log
        WHERE call_id = $1 AND stage = 'classify'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [callId],
    );
    if (rows[0]?.reason === CLASSIFY_DISABLED_REASON) return;
    await appendLog(client, {
      callId,
      stage: 'classify',
      outcome: 'deferred',
      detail: { reason: CLASSIFY_DISABLED_REASON },
    });
  });
}

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
      await parkDisabled(pool, callId);
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

/**
 * Run a DB side effect (reservation release / alert insert) during model-error handling so a
 * SECONDARY failure can never mask the ORIGINAL thrown error. A network/DB blip is exactly what
 * produces a `maybe_billed` transient error in the first place, so the release/alert writes here
 * are plausible to fail; if they do, we catch, log content-safely (only the secondary error's
 * name — never its message, which could carry an SDK/PII string; never transcript content), and
 * SWALLOW so control returns to the caller and its `throw err` re-surfaces the true root cause.
 *
 * When a release fails the reservation stays KEPT: that is the documented conservative bias
 * (under-spend, never over-spend the cost cap).
 */
async function resilientSideEffect(
  logger: Logger,
  callId: string,
  stage: string,
  note: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (secondary) {
    logger.error(
      {
        stage,
        call_id: callId,
        note,
        // Name/code only — the message may embed a raw SDK error string or PII.
        secondary_error: secondary instanceof Error ? secondary.name : typeof secondary,
      },
      'alert/release side-effect failed during model-error handling — swallowed so the original error propagates',
    );
  }
}

/**
 * Release-or-keep the reservation and record the mapped alert for a thrown model error, then
 * let the caller rethrow. The release/alert side effects are individually resilient (see
 * {@link resilientSideEffect}): a secondary DB failure is caught, logged content-safely, and
 * swallowed so the ORIGINAL model/config error is always what the caller rethrows — the
 * failure-model categorizes on the true root cause, never a masking DAL error.
 *
 * PRIVACY: only the ModelApiError's own fields (kind/status/billingDisposition) or a
 * ConfigError's variable name reach the snapshot — never a raw SDK error message, and the
 * caught error is never attached as `cause`.
 */
async function handleModelError(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  reservation: BudgetReservation,
  err: unknown,
  logger: Logger,
): Promise<void> {
  if (err instanceof ModelApiError) {
    // Release for not_sent/not_billed; KEEP for maybe_billed — releasing a maybe-billed
    // request could let real spend exceed the cap.
    if (err.billingDisposition !== 'maybe_billed') {
      await resilientSideEffect(logger, callId, stage, 'release (model error)', () =>
        releaseModelReservation(pool, reservation),
      );
    }
    if (err.kind === 'auth') {
      await resilientSideEffect(logger, callId, stage, 'alert MODEL_AUTH_FAILED', () =>
        recordStageAlert(pool, callId, stage, config, 'MODEL_AUTH_FAILED', 'paused', {
          status: err.status ?? null,
        }),
      );
    } else if (err.kind === 'rate_limited') {
      await resilientSideEffect(logger, callId, stage, 'alert MODEL_RATE_LIMITED', () =>
        recordStageAlert(pool, callId, stage, config, 'MODEL_RATE_LIMITED', 'degraded', {
          status: err.status ?? null,
        }),
      );
    }
    // 'transient'/'unexpected' → no stage alert; the dead-letter path (DEAD_LETTER_CREATED)
    // covers it, mirroring fetch-transcript's 'unavailable' disposition.
    return;
  }

  // Any OTHER thrown error is definitionally not-sent (e.g. getModel() throwing because
  // ANTHROPIC_API_KEY is missing) → release. If it safely reports the config code, record a
  // deduped CONFIG_MISSING_OR_INVALID alert; an enabled-but-misconfigured worker hits this
  // per job, so a fast, deduped signal is warranted. Both side effects are resilient so a
  // secondary DB failure cannot mask the original ConfigError.
  await resilientSideEffect(logger, callId, stage, 'release (config error)', () =>
    releaseModelReservation(pool, reservation),
  );
  if (hasConfigMissingCode(err)) {
    const failure = createFailure('CONFIG_MISSING_OR_INVALID', {
      processingState: 'paused',
      context: { call_id: callId, stage, environment: config.NODE_ENV },
    });
    // The offending variable NAME goes in the snapshot, NOT context — sanitizeContext
    // whitelists only call_id/job_id/environment/stage/component, so a `variable` key would
    // be dropped. The variable name is safe, non-secret metadata.
    const variable = configVariableName(err);
    await resilientSideEffect(logger, callId, stage, 'alert CONFIG_MISSING_OR_INVALID', () =>
      recordAlert(pool, {
        errorCode: failure.error_code,
        rootCauseCategory: failure.root_cause_category,
        severity: failure.severity,
        dedupKey: dedupKey(failure),
        failureSnapshot: {
          call_id: callId,
          stage,
          ...(variable !== undefined ? { variable } : {}),
        },
      }),
    );
  }
}

/** True if `err` safely reports `code === 'CONFIG_MISSING_OR_INVALID'` (the ConfigError shape). */
function hasConfigMissingCode(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'CONFIG_MISSING_OR_INVALID'
  );
}

/** The first offending variable name off a ConfigError-shaped `invalid` array, if present. */
function configVariableName(err: unknown): string | undefined {
  const invalid = (err as { invalid?: unknown }).invalid;
  if (Array.isArray(invalid) && typeof invalid[0] === 'string') return invalid[0];
  return undefined;
}

/** Exported so the Task 9 requeue script and tests share the marker string. */
export { CLASSIFY_DISABLED_REASON };
