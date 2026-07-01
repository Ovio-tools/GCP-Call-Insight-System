import type { PipelineStage } from './stages.js';

/**
 * A conservative whitelist for values we are willing to persist: a leading letter followed by
 * up to 63 identifier chars. Error class names (`DalError`, `TypeError`) and stable codes
 * (`DAL_STALE_STAGE`, `QUEUE_RETRY_EXHAUSTED`) match; anything with spaces, punctuation, or
 * free text does not. Fail-closed: an error whose `name`/`code` was tampered to carry content
 * (a future stage may touch transcript-adjacent data) is rejected, not stored.
 */
const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The error's `name` if it is a safe identifier, else the generic `Error`. Never free text. */
export function safeErrorName(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return SAFE_TOKEN.test(name) ? name : 'Error';
}

/** The error's `code` if present AND a safe identifier, else undefined (omit, don't guess). */
export function safeErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' && SAFE_TOKEN.test(code)) return code;
  }
  return undefined;
}

/**
 * Raised when a pipeline stage handler throws. Wraps the original failure so the worker's
 * `failed` handler knows exactly WHICH stage failed — the raw BullMQ job/error alone cannot
 * tell us.
 *
 * Fail-closed from day one: this carries ONLY the failed stage, the original error's `name`,
 * and an optional safe `code`. It NEVER captures the raw `err.message`, because future stages
 * touch transcript-adjacent data and a message could leak content or PII.
 */
export class PipelineStageError extends Error {
  readonly stage: PipelineStage;
  readonly callId: string;
  readonly causeName: string;
  readonly causeCode: string | undefined;

  constructor(stage: PipelineStage, callId: string, cause: unknown) {
    super(`Stage ${stage} failed: ${safeErrorName(cause)}`);
    this.name = 'PipelineStageError';
    this.stage = stage;
    this.callId = callId;
    this.causeName = safeErrorName(cause);
    this.causeCode = safeErrorCode(cause);
  }
}
