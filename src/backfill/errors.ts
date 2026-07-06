/**
 * Refusal / stop errors for the Task 11.2 historical backfill runner.
 *
 * The backfill is "the highest-volume PII move" in the system, so it refuses loudly and early. Each
 * error is a hard stop; the runbook pointer for the recoverable one (`checkpoint_failed`) is
 * `runbook#backfill-checkpoint-failed`. Like {@link SampleValidationError}/`DalError`, `context`
 * carries ONLY sanitized identifiers (env name, call id, run id, phase, missing gate-type
 * constants) — never a transcript, vault value, connection string, secret, URL, or PII.
 *
 * These are a small bespoke error type, NOT a new failure-model category: most fire at CLI start
 * before any pipeline work and emit no alert. The ONE alerting path — a checkpoint-write failure —
 * emits `BACKFILL_CHECKPOINT_FAILED` (already cataloged) alongside throwing `checkpoint_failed`.
 */

export type BackfillRefusalReason =
  /** NODE_ENV is `development` or `test` — real backfill is production-only, synthetic is staging-only. */
  | 'not_live_environment'
  /** NODE_ENV is `staging` but no `--synthetic-dialpad-fixture` was supplied (staging is synthetic-only). */
  | 'staging_requires_synthetic'
  /** NODE_ENV is `production` but a synthetic fixture was supplied (production runs real data only). */
  | 'production_no_synthetic'
  /** A required §0.2 processing gate (or the conditional ServiceTitan matching consent) is absent. */
  | 'missing_consent_gates'
  /** Another backfill run already holds the advisory lock. */
  | 'already_running'
  /** A resumable run exists for the window but neither `--resume` nor `--restart-from-scratch` was given. */
  | 'resumable_run_exists'
  /** More than one resumable run exists for the exact window (should be impossible under the unique index). */
  | 'ambiguous_resumable_run'
  /** `--resume <id>` names a run whose stored window does not match the requested `--from`/`--to`. */
  | 'resume_window_mismatch'
  /** The stored checkpoint JSON is malformed / unparseable — fail closed, refuse to run. */
  | 'invalid_checkpoint'
  /** A listed page contained an item with no parseable `startedAt` — fail closed before checkpointing. */
  | 'missing_started_at'
  /** A synthetic fixture is malformed, or would return a not-ready transcript (deferral is unsupported inline). */
  | 'invalid_synthetic_fixture'
  /** `--match-keys` was requested; match-key write-back is not implemented until Task 12. */
  | 'match_keys_unsupported'
  /** A checkpoint write failed; the run stops cleanly at the last good checkpoint (resumable). */
  | 'checkpoint_failed'
  /** `--from`/`--to` are missing, unparseable, or out of order. */
  | 'invalid_window';

/** A hard stop from the backfill runner. `context` is sanitized (no secrets, no PII, no content). */
export class BackfillError extends Error {
  readonly reason: BackfillRefusalReason;
  readonly context: Record<string, string | readonly string[]>;

  constructor(
    reason: BackfillRefusalReason,
    message: string,
    context: Record<string, string | readonly string[]> = {},
  ) {
    super(message);
    this.name = 'BackfillError';
    this.reason = reason;
    this.context = context;
  }
}
