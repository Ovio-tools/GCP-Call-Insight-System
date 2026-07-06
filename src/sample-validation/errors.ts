/**
 * Refusal errors for the Task 11.1 sample-validation harness.
 *
 * The harness is the ONE consented exception to the synthetic-only rule (plan §0.2): it may run a
 * small batch of real calls, but only in staging, only against non-production stores, and only
 * after every §0.2 processing gate is recorded. Each refusal is a hard stop BEFORE any call fetch,
 * model call, queue enqueue, pipeline execution, or report write.
 *
 * These are deliberately a small bespoke error type rather than a new failure-model category: the
 * harness refuses at CLI start and emits no alert, so it does not need the alert/dedup/severity
 * machinery of `src/failure-model/`. Like `DalError`, `context` carries ONLY sanitized identifiers
 * (env name, resource kind, gate-type constants) — never a connection string, secret, URL, or PII.
 */

export type SampleValidationRefusalReason =
  /** NODE_ENV is not `staging` — the harness runs in staging only, even with credentials present. */
  | 'not_staging'
  /** A configured database / queue / service endpoint resolves to a production host. */
  | 'production_resource'
  /** The operator-provided sample size or call-id list is missing, empty, or over the cap. */
  | 'invalid_sample_selection'
  /** A required §0.2 processing gate (or the conditional ServiceTitan matching consent) is absent. */
  | 'missing_consent_gates'
  /** A reviewer note tripped the residual-PII gate and was refused rather than stored. */
  | 'reviewer_note_unsafe';

/** A hard refusal from the sample-validation harness. `context` is sanitized (no secrets, no PII). */
export class SampleValidationError extends Error {
  readonly reason: SampleValidationRefusalReason;
  readonly context: Record<string, string | readonly string[]>;

  constructor(
    reason: SampleValidationRefusalReason,
    message: string,
    context: Record<string, string | readonly string[]> = {},
  ) {
    super(message);
    this.name = 'SampleValidationError';
    this.reason = reason;
    this.context = context;
  }
}
