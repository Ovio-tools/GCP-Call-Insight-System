import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { ModelApiError } from '../anthropic/client.js';
import { type BudgetReservation, releaseModelReservation } from '../model/cost.js';
import {
  type Component,
  type ErrorCode,
  type ProcessingState,
  createFailure,
  dedupKey,
  failureSnapshot,
} from '../failure-model/index.js';
import { recordAlert, recordAlertWithInsertStatus } from '../db/repositories/alert-events-repo.js';
import { appendLog } from '../db/repositories/processing-log-repo.js';
import { query, withTransaction } from '../db/sql.js';

/**
 * Helpers shared by the model-backed pipeline stages (classify, and Task 5.2's extract) and by
 * the out-of-pipeline technician-note batch generator (ADR 0009). Everything here is
 * parameterized by `stage` so every caller reuses one implementation of the kill-switch park,
 * the deduped stage alert, and the model-error disposition logic.
 *
 * NON-PIPELINE CALLERS must also pass `component`. `sanitizeContext` validates the `stage`
 * context key against `isPipelineStage` and silently DROPS anything else, so a caller whose
 * `stage` is not a member of PIPELINE_STAGES (e.g. 'technician-note') would otherwise produce
 * an alert with no scope at all. The `stage` argument is still threaded through — it names the
 * work in log lines and in the snapshot's top-level diagnostics, where no allowlist applies.
 */

/**
 * Record a deduped stage alert for a mapped model failure. Context is sanitized to
 * call_id/stage/component/environment only; the failureSnapshot mirrors fetch-transcript's shape
 * and NEVER carries transcript content, model reasons, or a raw SDK error message.
 */
export async function recordStageAlert(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  code: ErrorCode,
  processingState: ProcessingState,
  extraSnapshot: Record<string, string | number | boolean | null> = {},
  component?: Component,
): Promise<void> {
  const failure = createFailure(code, {
    processingState,
    context: {
      call_id: callId,
      stage,
      environment: config.NODE_ENV,
      ...(component !== undefined ? { component } : {}),
    },
  });
  await recordAlert(pool, {
    errorCode: failure.error_code,
    rootCauseCategory: failure.root_cause_category,
    severity: failure.severity,
    dedupKey: dedupKey(failure),
    // Full §4 snapshot (Task 7.4) so alert_events stays explainable after the alert is gone,
    // plus the sanitized top-level diagnostics (call_id/stage + closed-vocab counts/status).
    failureSnapshot: { ...failureSnapshot(failure), call_id: callId, stage, ...extraSnapshot },
  });
}

/**
 * Record a deduped `VERBATIM_PII_DETECTED` alert (severity comes from the catalog: high)
 * for a second-PII-scan hold, WRAPPED in {@link resilientSideEffect} so an alert-insert
 * failure can never prevent or convert the hold — the caller records the alert, then
 * returns the hold regardless of alert success.
 *
 * `counts` is the residual-scan category→count map: a CLOSED-vocabulary key set with
 * numeric values. It IS the counts-only failureSnapshot; the caller guarantees it carries
 * only `residualScan` counts, so no phrase text or PII-shaped key can ride into the alert.
 */
export async function recordVerbatimPiiDetectedAlertResilient(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  counts: Record<string, number>,
  logger: Logger,
): Promise<void> {
  await resilientSideEffect(logger, callId, stage, 'alert VERBATIM_PII_DETECTED', () =>
    recordStageAlert(pool, callId, stage, config, 'VERBATIM_PII_DETECTED', 'degraded', counts),
  );
}

/**
 * Emit the advisory daily-cost warning alert (Task 7.2) when a reservation lands the day's
 * estimated spend at/above the warning threshold — at most ONCE per UTC day, including after a
 * same-day acknowledgment, and WITHOUT ever blocking the pipeline. Shared by classify + extract;
 * called AFTER the reserve null-check and BEFORE the model call. A no-op when the level was not
 * reached.
 *
 * `reserveModelBudget` returns a LEVEL flag (true on EVERY admitted reservation at/above the
 * threshold, not a one-shot crossing), so this can re-attempt on later calls; the day-scoped
 * dedup guard below collapses those attempts to a single row, and `inserted === true` gates the
 * log line to the first insert.
 *
 * The whole emit is wrapped in {@link resilientSideEffect}: an alert-insert failure is
 * sanitized-logged and swallowed so it can never convert or block the call (advisory, not a gate).
 *
 * Strict once-per-day dedup — no new table. The `alert_events` partial-unique index dedups only
 * ACTIVE (unacknowledged) rows, which is insufficient here: because the emit re-attempts on every
 * above-threshold reservation, an operator acknowledging the warning at noon would have it
 * re-fired by the next model call. So the emit runs lock → check → insert inside ONE transaction,
 * mirroring `reserveModelBudget`:
 *   1. advisory xact lock on the day-scoped dedup key — serializes concurrent emitters for the day;
 *   2. existence check (matches acknowledged rows too) — skip if any row already exists;
 *   3. otherwise insert on the SAME transaction client.
 * The lock closes the check-then-insert TOCTOU (without it two workers could both see "no active
 * row" after an ack and both insert). The next UTC day the key changes → a fresh row re-fires.
 *
 * PRIVACY: context is `{ stage, component?, environment }` only (no call_id — the alert is
 * day-scoped, not call-scoped) and the day rides in the dedup KEY, never in `context`
 * (sanitizeContext's allowlist would strip a day key). The persisted snapshot is the full
 * sanitized §4 failure — no PII.
 *
 * The dedup key is deliberately NOT component-scoped: the daily cap is shared across every model
 * caller, so the warning stays one-per-UTC-day system-wide. A non-pipeline caller passing
 * `component` only changes which scope the alert is LABELLED with, never how often it fires.
 */
export async function emitCostWarningIfReached(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  reservation: BudgetReservation,
  logger: Logger,
  component?: Component,
): Promise<void> {
  if (!reservation.warningThresholdReached) return;
  const failure = createFailure('MODEL_COST_WARNING_THRESHOLD_EXCEEDED', {
    processingState: 'continuing',
    context: {
      stage,
      environment: config.NODE_ENV,
      ...(component !== undefined ? { component } : {}),
    },
  });
  const dedupKeyForDay = `MODEL_COST_WARNING_THRESHOLD_EXCEEDED:day:${reservation.day}`;
  await resilientSideEffect(
    logger,
    callId,
    stage,
    'alert MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
    () =>
      withTransaction(pool, async (client) => {
        // (1) Serialize all same-day emitters. hashtextextended(text, 0) → bigint, the single-bigint
        // advisory-lock overload. Protects the same-day acknowledgment race (see the doc comment).
        await query(client, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          dedupKeyForDay,
        ]);
        // (2) Existence check — matches acknowledged rows too, so an acknowledged warning is NOT
        // re-fired the same day.
        const existing = await query<{ id: string }>(
          client,
          `SELECT id FROM alert_events WHERE dedup_key = $1 LIMIT 1`,
          [dedupKeyForDay],
        );
        if (existing[0]) return;
        // (3) Insert on the same transaction client, with the full sanitized §4 snapshot.
        const { inserted } = await recordAlertWithInsertStatus(client, {
          errorCode: failure.error_code,
          rootCauseCategory: failure.root_cause_category,
          severity: failure.severity,
          dedupKey: dedupKeyForDay,
          failureSnapshot: failureSnapshot(failure),
        });
        if (inserted) {
          logger.info(
            { stage, dedup_key: dedupKeyForDay },
            'daily model-cost warning threshold reached — advisory alert emitted (pipeline continues)',
          );
        }
      }),
  );
}

/**
 * Kill-switch park (atomically idempotent). Inside a transaction, takes an advisory xact
 * lock on `${stage}-disabled:${callId}` so two concurrent runs of the disabled handler
 * serialize, then appends ONE `deferred` processing_log row only if the LATEST row for the
 * stage isn't already the `marker` reason. Returns after committing.
 *
 * Parked calls are recovered by the Task 9 requeue script AFTER re-enabling the stage's
 * feature flag; reconciliation does not rescue them (they were never lost, just deferred).
 */
export async function parkStageDisabled(
  pool: Pool,
  callId: string,
  stage: string,
  marker: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await query(client, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${stage}-disabled:${callId}`,
    ]);
    // Is the LATEST processing_log row for this stage already the disabled marker? If so,
    // this is a re-run of an already-parked call — append nothing (idempotency).
    // The id DESC tie-break assumes distinct created_at per row (processing_log.id is a random
    // uuid, not monotonic); this holds because the park marker and any later genuine stage
    // log are always written in separate transactions, so their created_at differs.
    const rows = await query<{ reason: string | null }>(
      client,
      `SELECT detail->>'reason' AS reason
         FROM processing_log
        WHERE call_id = $1 AND stage = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [callId, stage],
    );
    if (rows[0]?.reason === marker) return;
    await appendLog(client, {
      callId,
      stage,
      outcome: 'deferred',
      detail: { reason: marker },
    });
  });
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
export async function resilientSideEffect(
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
export async function handleModelError(
  pool: Pool,
  callId: string,
  stage: string,
  config: Config,
  reservation: BudgetReservation,
  err: unknown,
  logger: Logger,
  component?: Component,
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
        recordStageAlert(
          pool,
          callId,
          stage,
          config,
          'MODEL_AUTH_FAILED',
          'paused',
          { status: err.status ?? null },
          component,
        ),
      );
    } else if (err.kind === 'rate_limited') {
      await resilientSideEffect(logger, callId, stage, 'alert MODEL_RATE_LIMITED', () =>
        recordStageAlert(
          pool,
          callId,
          stage,
          config,
          'MODEL_RATE_LIMITED',
          'degraded',
          { status: err.status ?? null },
          component,
        ),
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
      context: {
        call_id: callId,
        stage,
        environment: config.NODE_ENV,
        ...(component !== undefined ? { component } : {}),
      },
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
          ...failureSnapshot(failure),
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
