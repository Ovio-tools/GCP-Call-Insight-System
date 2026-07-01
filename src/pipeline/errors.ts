import type { PipelineStage } from './stages.js';

/** A safe error `code`, if the underlying error carries one (e.g. a DAL error code). */
function safeCodeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

/** The error `name`, defaulting to `Error` — always safe (a class name, never content). */
function safeNameOf(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return 'Error';
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
    super(`Stage ${stage} failed: ${safeNameOf(cause)}`);
    this.name = 'PipelineStageError';
    this.stage = stage;
    this.callId = callId;
    this.causeName = safeNameOf(cause);
    this.causeCode = safeCodeOf(cause);
  }
}
