import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  type TechnicianNoteModelClient,
  TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON,
} from '../anthropic/client.js';
import type { Config } from '../config/schema.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { recordModelInvocation } from '../db/repositories/model-invocations-repo.js';
import { appendLog } from '../db/repositories/processing-log-repo.js';
import { upsertTechnicianNote } from '../db/repositories/technician-notes-repo.js';
import {
  type ModelRates,
  type BudgetReservation,
  estimateCostUsd,
  estimatePayloadTokens,
  reserveModelBudget,
  settleModelUsage,
} from '../model/cost.js';
import {
  emitCostWarningIfReached,
  handleModelError,
  recordStageAlert,
  recordVerbatimPiiDetectedAlertResilient,
} from '../pipeline/model-stage-shared.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { TechnicianNoteError } from './errors.js';
import {
  assertDispatchSummaryLength,
  computeNotEstablished,
  scanNoteForResidual,
} from './gates.js';
import { type ParseFailureKind, parseTechnicianNote } from './parse.js';
import {
  TECHNICIAN_NOTE_PROMPT_VERSION,
  TECHNICIAN_NOTE_SCHEMA_VERSION,
  TECHNICIAN_NOTE_SYSTEM_PROMPT,
  buildTechnicianNoteRetryUserMessage,
  buildTechnicianNoteUserMessage,
} from './prompt.js';

/**
 * The per-call technician-note generator (ADR 0009).
 *
 * NOT a pipeline stage: it is never in PIPELINE_STAGES and never touches the state machine. A
 * note is derived and optional, so a failure here NEVER holds the call and NEVER writes a
 * review_queue row — a hold would block the CLEAN retention purge through `cleanBlocking` and
 * silently extend how long redacted customer text is retained, for a cosmetic failure. No note is
 * the correct degraded state; the outcome is recorded in processing_log and the run aggregates it.
 *
 * Privacy: only the redacted text crosses to Anthropic. No transcript content, no note field
 * value, and no raw SDK error message ever reaches a log line, alert snapshot, or processing_log
 * detail. Everything persisted or logged here is a count, a boolean, or a constant id.
 *
 * Isolation: this module reads `clean_transcripts` and nothing else on the input side. It is
 * structurally unable to reach DB-B — `assertNoRawStoreAccess` refuses at CONSTRUCTION if it is
 * handed a raw-store pool, a restricted runner, or anything that can unwrap key material.
 */

/** The `stage` label on this job's processing_log and model_invocations rows. Deliberately NOT a
 * member of PIPELINE_STAGES — both columns are free text with no CHECK, and adding it to the
 * pipeline vocabulary would put it in the state machine's walk. */
export const TECHNICIAN_NOTE_STAGE = 'technician-note';

/**
 * ADR 0007: parse-failure kinds worth ONE bounded retry with the validation feedback appended.
 * Identical to the extract stage's set, and excluded for the same reasons: `refusal` is
 * deliberate model behavior, and `truncated` would burn a full reservation on near-identical
 * params.
 */
const RETRYABLE_PARSE_FAILURES: ReadonlySet<ParseFailureKind> = new Set([
  'empty',
  'non_json',
  'schema_invalid',
  'unexpected_stop_reason',
]);

/** What happened to one call. Every value is a constant id — safe to log and to aggregate. */
export type NoteOutcome =
  /** A note was written (or replaced). */
  | 'generated'
  /** No readable clean transcript: absent, soft-deleted, or hard-deleted. Never generated from
   * the structured_knowledge record instead — that record is derived output, not the source. */
  | 'skipped_no_transcript'
  /** The daily model cost cap would be exceeded. The RUN pauses on this; it is not a failure. */
  | 'cost_cap'
  /** Model output failed validation twice (once, then the bounded retry). No note written. */
  | 'failed_schema'
  /** The Anthropic call itself threw (auth, rate limit, transport). No note written. */
  | 'failed_model';

export interface NoteGenerationResult {
  outcome: NoteOutcome;
  /** Residual-scan categories → counts, when the scan found anything. Counts only, never text. */
  residualCounts?: Readonly<Record<string, number>>;
  /** How many required-for-dispatch fields the call left unsettled, when a note was written. */
  notEstablishedCount?: number;
}

export interface TechnicianNoteGeneratorDeps {
  /** The MAIN application pool (DB-A). Never a raw-store pool — asserted at construction. */
  pool: Pool;
  config: Config;
  logger: Logger;
  /** Lazy thunk, invoked only AFTER the transcript and cost-cap gates pass, so a skipped call
   * never constructs an SDK client and a missing API key never fails a dry run. */
  getModel: () => TechnicianNoteModelClient;
  /** Injected time (UTC-day derivation for the cost cap). */
  clock?: { now: () => number };
  /** Deny terms; when absent they are loaded ONCE at construction from config. */
  denyTerms?: readonly string[];
}

export type TechnicianNoteGenerator = (callId: string) => Promise<NoteGenerationResult>;

/** Duck-typed key surfaces. Anything exposing one of these can unwrap DEK/KEK material. */
const KEY_SURFACE_METHODS = [
  'getDek',
  'currentKeyVersion',
  'unwrapDek',
  'createDek',
  'destroyDek',
  'recoverability',
] as const;

function looksLikeKeyAccess(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return KEY_SURFACE_METHODS.some((m) => typeof obj[m] === 'function');
}

/**
 * Refuse, at CONSTRUCTION, anything that could reach the raw store or key material.
 *
 * `createRawAppPool` returns a plain `pg.Pool` with no brand or marker, so TypeScript cannot tell
 * DB-A from DB-B and `instanceof` cannot either. The connection string is the only runtime
 * discriminator available, so that is what this compares. The key-surface and restricted-runner
 * checks are duck-typed for the same reason.
 *
 * This runs synchronously and throws rather than degrading: a generator that can reach DB-B is
 * not a generator with a bug, it is a privacy-boundary violation (CLAUDE.md §1.2).
 */
function assertNoRawStoreAccess(deps: TechnicianNoteGeneratorDeps): void {
  for (const [name, value] of Object.entries(deps)) {
    if (looksLikeKeyAccess(value)) {
      throw new TechnicianNoteError(
        'raw_store_access_forbidden',
        `technician-note generator was handed key-material access via '${name}' — it reads redacted text only`,
        { dependency: name },
      );
    }
  }

  const pool = deps.pool as unknown as Record<string, unknown>;
  // A RestrictedRunner is `{ run(fn) }` with no query/connect — the DB-B vault accessor shape.
  if (typeof pool.run === 'function' && typeof pool.query !== 'function') {
    throw new TechnicianNoteError(
      'raw_store_access_forbidden',
      'technician-note generator was handed a restricted (vault) runner instead of the application pool',
      { dependency: 'pool' },
    );
  }

  const rawUrl = deps.config.RAW_DATABASE_URL;
  const poolUrl = (pool.options as { connectionString?: unknown } | undefined)?.connectionString;
  if (
    rawUrl !== undefined &&
    rawUrl.length > 0 &&
    typeof poolUrl === 'string' &&
    poolUrl === rawUrl
  ) {
    throw new TechnicianNoteError(
      'raw_store_access_forbidden',
      'technician-note generator was handed the raw-store (DB-B) pool — it must never reach raw_transcripts or token_vault',
      { dependency: 'pool' },
    );
  }
}

export function createTechnicianNoteGenerator(
  deps: TechnicianNoteGeneratorDeps,
): TechnicianNoteGenerator {
  assertNoRawStoreAccess(deps);

  // A bad deny-list config fails CONSTRUCTION (ConfigError), never a per-call loop.
  const denyTerms = deps.denyTerms ?? loadDenyList(deps.config.REDACTION_DENY_LIST_PATH);
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());
  const { pool, config, logger } = deps;

  const rates: ModelRates = {
    inputUsdPerMtok: config.TECHNICIAN_NOTE_COST_USD_PER_MTOK_INPUT,
    outputUsdPerMtok: config.TECHNICIAN_NOTE_COST_USD_PER_MTOK_OUTPUT,
  };

  /** Reserve against the daily cap for one attempt, or null when the cap would be exceeded. */
  const reserve = async (userText: string): Promise<BudgetReservation | null> => {
    const reservedInputTokens = Math.max(
      config.TECHNICIAN_NOTE_INPUT_TOKENS_CEILING,
      estimatePayloadTokens({
        system: TECHNICIAN_NOTE_SYSTEM_PROMPT,
        userText,
        outputFormatJson: TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON,
        overheadTokens: config.TECHNICIAN_NOTE_RESERVATION_OVERHEAD_TOKENS,
      }),
    );
    const requestCostUsd = estimateCostUsd({
      inputTokens: reservedInputTokens,
      outputTokens: config.TECHNICIAN_NOTE_MAX_TOKENS,
      rates,
    });
    return reserveModelBudget(pool, { config, now: new Date(now()), requestCostUsd });
  };

  return async (callId: string): Promise<NoteGenerationResult> => {
    // 1. Input. `getCleanTranscript` filters soft- AND hard-deleted rows, so `undefined` covers
    //    all three absence cases. This is a COUNTED SKIP, never an error and never a fallback to
    //    the structured_knowledge record.
    const transcript = await getCleanTranscript(pool, callId);
    if (!transcript) {
      await appendLog(pool, {
        callId,
        stage: TECHNICIAN_NOTE_STAGE,
        outcome: 'skipped',
        detail: { reason: 'no_clean_transcript' },
      });
      logger.info(
        { call_id: callId, stage: TECHNICIAN_NOTE_STAGE },
        'no readable clean transcript — skipped',
      );
      return { outcome: 'skipped_no_transcript' };
    }

    const redactedText = transcript.redacted_text;
    const firstUserText = buildTechnicianNoteUserMessage(redactedText);

    // 2. Cost cap. A tripped cap PAUSES the run rather than failing it — the caller stops the
    //    loop and the alert is the operator signal.
    const reservation = await reserve(firstUserText);
    if (reservation === null) {
      await recordStageAlert(
        pool,
        callId,
        TECHNICIAN_NOTE_STAGE,
        config,
        'MODEL_COST_CAP_EXCEEDED',
        'paused',
        {},
        'technician-notes',
      );
      logger.info(
        { call_id: callId, stage: TECHNICIAN_NOTE_STAGE },
        'daily model cost cap reached — note run pausing',
      );
      return { outcome: 'cost_cap' };
    }
    await emitCostWarningIfReached(
      pool,
      callId,
      TECHNICIAN_NOTE_STAGE,
      config,
      reservation,
      logger,
      'technician-notes',
    );

    /** One attempt: call → parse → record invocation → settle. Never routes. */
    const attempt = async (
      userText: string,
      attemptReservation: BudgetReservation,
    ): Promise<{ usagePresent: boolean; parsed: ReturnType<typeof parseTechnicianNote> }> => {
      let result;
      try {
        result = await deps.getModel().generate({
          system: TECHNICIAN_NOTE_SYSTEM_PROMPT,
          userText,
        });
      } catch (err) {
        // Release-or-keep the reservation and record the mapped alert; the raw SDK message is
        // never propagated (the wrapper maps it to a fixed per-kind string).
        await handleModelError(
          pool,
          callId,
          TECHNICIAN_NOTE_STAGE,
          config,
          attemptReservation,
          err,
          logger,
          'technician-notes',
        );
        throw err;
      }

      const parsed = parseTechnicianNote({ text: result.text, stopReason: result.stopReason });

      // Record BEFORE routing, always, with the real (possibly 0) token counts.
      await recordModelInvocation(pool, {
        callId,
        stage: TECHNICIAN_NOTE_STAGE,
        modelId: config.TECHNICIAN_NOTE_MODEL_ID,
        promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        outcome: parsed.ok && result.usagePresent ? 'success' : 'malformed_response',
      });

      // When usage is missing the reservation is deliberately KEPT — never undercount the cap.
      if (result.usagePresent) {
        await settleModelUsage(pool, attemptReservation, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          rates,
        });
      }

      return { usagePresent: result.usagePresent, parsed };
    };

    let first;
    try {
      first = await attempt(firstUserText, reservation);
    } catch {
      // handleModelError already released-or-kept and alerted. The note is optional, so this is
      // a recorded outcome, not a throw: throwing would abort a batch over one bad call.
      await appendLog(pool, {
        callId,
        stage: TECHNICIAN_NOTE_STAGE,
        outcome: 'failed',
        detail: { reason: 'model_error', attempt: 1 },
      });
      logger.warn(
        { call_id: callId, stage: TECHNICIAN_NOTE_STAGE },
        'note model call failed — no note written',
      );
      return { outcome: 'failed_model' };
    }

    let { usagePresent, parsed } = first;
    let retryAttempted = false;
    let retrySkipped: 'cost_cap' | undefined;

    // 3. The ONE bounded retry (ADR 0007). Its own reserve / record / settle cycle; a
    //    cap-rejected second reservation is recorded, not converted into a cost-cap pause.
    if (!parsed.ok && usagePresent && RETRYABLE_PARSE_FAILURES.has(parsed.failure)) {
      const retryUserText = buildTechnicianNoteRetryUserMessage(
        redactedText,
        parsed.failure,
        parsed.issueSummary ?? [],
      );
      const retryReservation = await reserve(retryUserText);
      if (retryReservation === null) {
        retrySkipped = 'cost_cap';
        logger.info(
          { call_id: callId, stage: TECHNICIAN_NOTE_STAGE },
          'note retry skipped — daily cost cap would be exceeded',
        );
      } else {
        retryAttempted = true;
        try {
          ({ usagePresent, parsed } = await attempt(retryUserText, retryReservation));
        } catch {
          await appendLog(pool, {
            callId,
            stage: TECHNICIAN_NOTE_STAGE,
            outcome: 'failed',
            detail: { reason: 'model_error', attempt: 2 },
          });
          logger.warn(
            { call_id: callId, stage: TECHNICIAN_NOTE_STAGE },
            'note model call failed on retry — no note written',
          );
          return { outcome: 'failed_model' };
        }
      }
    }

    if (!parsed.ok) {
      // Second failure: record the outcome and move on. No note, no hold, no review_queue row.
      // `issueSummary` is NEVER persisted — it can embed the received value.
      await appendLog(pool, {
        callId,
        stage: TECHNICIAN_NOTE_STAGE,
        outcome: 'failed',
        detail: {
          reason: 'schema_invalid',
          failure: parsed.failure,
          retry_attempted: retryAttempted,
          ...(retrySkipped !== undefined ? { retry_skipped: retrySkipped } : {}),
        },
      });
      logger.warn(
        {
          call_id: callId,
          stage: TECHNICIAN_NOTE_STAGE,
          failure: parsed.failure,
          retry_attempted: retryAttempted,
        },
        'note output failed validation — no note written',
      );
      return { outcome: 'failed_schema' };
    }

    // 4. Gates, in PII-first order: residual scan (which can null a field) BEFORE the gap list,
    //    so a field nulled for PII correctly shows up as not established.
    const { record: scanned, residual } = scanNoteForResidual(parsed.record, denyTerms);
    if (residual.hit) {
      // Residual PII in model output is exactly what VERBATIM_PII_DETECTED exists for. It is
      // recorded (deduped, counts-only, resilient) but it does NOT hold: the field is already
      // nulled, so the note that gets written is clean.
      await recordVerbatimPiiDetectedAlertResilient(
        pool,
        callId,
        TECHNICIAN_NOTE_STAGE,
        config,
        residual.counts,
        logger,
      );
    }

    const notEstablished = computeNotEstablished(scanned);
    assertDispatchSummaryLength(scanned);

    // 5. Persist. Idempotent upsert on call_id — a re-run replaces the note, never duplicates it.
    await upsertTechnicianNote(pool, {
      callId,
      promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
      modelId: config.TECHNICIAN_NOTE_MODEL_ID,
      schemaVersion: TECHNICIAN_NOTE_SCHEMA_VERSION,
      scopeSignal: scanned.scope_signal,
      occupancy: scanned.occupancy,
      equipment: scanned.equipment,
      systemContext: scanned.system_context,
      waterStatus: scanned.water_status,
      payerAuthority: scanned.payer_authority,
      priorWork: scanned.prior_work,
      commitmentsMade: scanned.commitments_made,
      locationOnProperty: scanned.location_on_property,
      symptomVerbatim: scanned.symptom_verbatim,
      priorAttemptsDetail: scanned.prior_attempts_detail,
      accessNotes: scanned.access_notes,
      hazards: scanned.hazards,
      urgencyContext: scanned.urgency_context,
      notEstablished,
      dispatchSummary: scanned.dispatch_summary,
    });

    await appendLog(pool, {
      callId,
      stage: TECHNICIAN_NOTE_STAGE,
      outcome: 'completed',
      detail: {
        prompt_version: TECHNICIAN_NOTE_PROMPT_VERSION,
        not_established_count: notEstablished.length,
        retry_attempted: retryAttempted,
        residual_hit: residual.hit,
        ...(residual.hit
          ? {
              residual_categories: Object.keys(residual.counts),
              residual_counts: { ...residual.counts },
              residual_fields_nulled: [...residual.fieldsNulled],
            }
          : {}),
      },
    });

    logger.info(
      {
        call_id: callId,
        stage: TECHNICIAN_NOTE_STAGE,
        not_established_count: notEstablished.length,
        residual_hit: residual.hit,
      },
      'technician note written',
    );

    return {
      outcome: 'generated',
      notEstablishedCount: notEstablished.length,
      ...(residual.hit ? { residualCounts: residual.counts } : {}),
    };
  };
}
