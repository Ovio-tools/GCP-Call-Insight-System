import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';
import type { Severity } from '../db/enums.js';
import type { JsonValue } from '../db/types.js';
import {
  type ErrorCode,
  type FailureError,
  type ProcessingState,
  createFailure,
  dedupKey,
} from '../failure-model/index.js';
import { recordAlertWithInsertStatus } from '../db/repositories/alert-events-repo.js';
import { type DeliverDeps, type DeliveryOutcome, deliverAlertRow } from './deliver.js';

/** Environments where a critical alert with no delivery channel is unacceptable. */
const MONITORED_ENVS: ReadonlySet<Config['NODE_ENV']> = new Set(['staging', 'production']);

/**
 * Fail-fast guard for the alerting entrypoint: in staging/production `ALERT_WEBHOOK_URL` MUST
 * be set, or critical alerts would be silently undeliverable. Emits CONFIG_MISSING_OR_INVALID
 * naming the exact variable (the same shape as {@link requireCheckUrl}). Outside those
 * environments delivery is optional (rows stay `pending`; the sweep no-ops).
 */
export function requireAlertWebhookUrl(config: Config): void {
  if (MONITORED_ENVS.has(config.NODE_ENV) && !config.ALERT_WEBHOOK_URL) {
    throw new ConfigError(
      ['ALERT_WEBHOOK_URL'],
      `${CONFIG_ERROR_CODE}: ALERT_WEBHOOK_URL is required in ${config.NODE_ENV} — critical alerts must be deliverable`,
    );
  }
}

/** Coarse, log-safe token for an unknown throwable. */
function coarse(err: unknown): string {
  return err instanceof Error ? err.name || err.constructor.name : typeof err;
}

/** The full sanitized failure fields persisted into `failure_snapshot`, so a later retry
 * renders the exact alert text from the row alone (`renderAlertEventText` path 1). */
function toSnapshot(f: FailureError): Record<string, JsonValue> {
  return {
    error_code: f.error_code,
    root_cause_category: f.root_cause_category,
    severity: f.severity,
    impact: f.impact,
    processing_state: f.processing_state,
    remediation_now: f.remediation_now,
    remediation_fix: f.remediation_fix,
    data_safe: f.data_safe,
    calls_state: f.calls_state,
    owner: f.owner,
    runbook_ref: f.runbook_ref,
    context: f.context,
  };
}

export interface EmitAlertInput {
  code: ErrorCode;
  processingState: ProcessingState;
  /** Sanitized-on-store identifiers (call_id, job_id, environment, stage, component). */
  context?: Record<string, string>;
  /** Override the default severity for this occurrence. */
  severity?: Severity;
}

export interface EmitAlertResult {
  /** Whether the alert row was recorded (or already existed). */
  recorded: boolean;
  /** Whether THIS call inserted a new row (vs. deduped onto an existing one). */
  inserted: boolean;
  /** Immediate-delivery outcome for a newly inserted row; `not-attempted` otherwise. */
  delivery: DeliveryOutcome | 'not-attempted';
}

/**
 * Application-level alert entry point (Task 7.3). Records the alert (deduped) and, on a NEWLY
 * inserted row, attempts IMMEDIATE delivery. A duplicate does not reset delivery state, so a
 * once-delivered incident is never re-sent. Best-effort throughout: a record failure (e.g. DB
 * down) or a delivery failure is sanitized-logged and reflected in the result — it NEVER
 * throws into the producer. The retry sweep is the safety net for any row left `pending`/
 * `failed`.
 */
export async function emitAlert(
  pool: Pool,
  config: Config,
  input: EmitAlertInput,
  deps: DeliverDeps,
): Promise<EmitAlertResult> {
  try {
    const failure = createFailure(input.code, {
      processingState: input.processingState,
      ...(input.context ? { context: input.context } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
    });
    const { row, inserted } = await recordAlertWithInsertStatus(pool, {
      errorCode: failure.error_code,
      rootCauseCategory: failure.root_cause_category,
      severity: failure.severity,
      dedupKey: dedupKey(failure),
      failureSnapshot: toSnapshot(failure),
    });
    if (!inserted) {
      return { recorded: true, inserted: false, delivery: 'not-attempted' };
    }
    const delivery = await deliverAlertRow(pool, config, row, deps);
    return { recorded: true, inserted: true, delivery };
  } catch (err) {
    deps.logger.warn(
      { component: 'alerting', error_code: input.code },
      `emitAlert failed to record (${coarse(err)})`,
    );
    return { recorded: false, inserted: false, delivery: 'not-attempted' };
  }
}
