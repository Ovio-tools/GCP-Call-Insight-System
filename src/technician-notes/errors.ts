/**
 * Refusal / stop errors for the technician-note batch generator (ADR 0009).
 *
 * Mirrors {@link BackfillError}: a small bespoke error type, NOT a new failure-model category.
 * Every reason here fires at construction or run start, before any model call, and emits no
 * alert — the CLI turns it into a sanitized one-line stderr message and a non-zero exit. The one
 * alerting path in this module (a run whose failure RATE crossed its threshold) emits the
 * cataloged `TECHNICIAN_NOTE_RUN_DEGRADED` instead, and does not throw.
 *
 * `context` carries ONLY sanitized identifiers — never a transcript, a note field value, a
 * connection string, a secret, a URL, or PII.
 */

export type TechnicianNoteRefusalReason =
  /** `TECHNICIAN_NOTES_ENABLED` is false. A run-level refusal, not a per-call park. */
  | 'disabled'
  /** Another note run already holds the advisory lock. */
  | 'already_running'
  /**
   * The generator was handed something that can reach DB-B or unwrap key material — a raw-store
   * pool, a restricted runner, a KeyProvider, or a KeyStore. This job reads redacted text only;
   * it must be structurally unable to touch `raw_transcripts` or `token_vault`.
   */
  | 'raw_store_access_forbidden';

/** A hard stop from the note generator. `context` is sanitized (no secrets, no PII, no content). */
export class TechnicianNoteError extends Error {
  readonly reason: TechnicianNoteRefusalReason;
  readonly context: Record<string, string | readonly string[]>;

  constructor(
    reason: TechnicianNoteRefusalReason,
    message: string,
    context: Record<string, string | readonly string[]> = {},
  ) {
    super(message);
    this.name = 'TechnicianNoteError';
    this.reason = reason;
    this.context = context;
  }
}
