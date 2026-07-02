import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { JsonValue } from '../db/types.js';
import type { DropReason } from '../db/enums.js';

/**
 * The per-call pipeline stages, in order (build plan §3). This is the single source of
 * truth for stage names and ordering — the state-machine runner walks this list.
 *
 * `purge` is intentionally absent: it is a separate scheduled job (Task 8.1), never a
 * per-call stage.
 */
export const PIPELINE_STAGES = [
  'metadata-pre-filter',
  'fetch-transcript',
  'transcript-availability',
  'redact',
  'classify',
  'extract',
  'verbatim-pii-scan',
  'store',
  'mark-retention-eligible',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The final stage. A completed call rests here (its `status` carries completion). */
export const FINAL_STAGE: PipelineStage = 'mark-retention-eligible';

/**
 * `call_state.status` values this task owns. `status` is a free `text` column in the schema
 * (its value set is owned by the pipeline), so the vocabulary lives here.
 *
 * - `processing` — seeded / in flight through the stages.
 * - `completed` — reached the end of the pipeline. Terminal. Paired with
 *   `current_stage = 'mark-retention-eligible'`. Note: `current_stage` is NEVER set to a
 *   terminal marker; completion is expressed by `status` alone, so the status surface's
 *   per-stage counts stay meaningful.
 */
export const STATUS_PROCESSING = 'processing';
export const STATUS_COMPLETED = 'completed';

/**
 * `skipped` — the metadata pre-filter dropped this call before fetch-transcript.
 * Terminal, paired with `current_stage` staying at the dropping stage and a non-null
 * `call_state.drop_reason`. Never advances.
 */
export const STATUS_SKIPPED = 'skipped';

/**
 * Stages permitted to end in a `skipped` drop. Only the metadata pre-filter drops today;
 * the runner's terminal `skipped` guard validates `current_stage` against this set.
 */
export const SKIP_STAGES: ReadonlySet<PipelineStage> = new Set(['metadata-pre-filter']);

/** True for a stage name that is a real member of the pipeline. */
export function isPipelineStage(stage: string): stage is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(stage);
}

/**
 * What a stage handler asks the runner to do next:
 * - `continue` — advance to the next stage (the default; `void`/`undefined` also means this).
 * - `drop` — stop the pipeline before the next stage; the runner calls `skipCall` with
 *   `reason` (a controlled `DropReason`), leaving the call `skipped` and recoverable.
 */
export type StageResult =
  | { action: 'continue' }
  | { action: 'drop'; reason: DropReason; detail?: Record<string, JsonValue> };

/** Context handed to each stage handler. `pool` lets a real stage read/write the DB. */
export interface StageContext {
  callId: string;
  stage: PipelineStage;
  logger: Logger;
  pool: Pool;
}

/**
 * A single stage's work. Returns a {@link StageResult}; returning `void` is treated as
 * `{ action: 'continue' }`, so trivial stub stages need no explicit return.
 */
export type StageHandler = (ctx: StageContext) => Promise<StageResult | void>;

export type StageHandlers = Record<PipelineStage, StageHandler>;

/**
 * Default handlers: each stage is a stub that logs and returns, letting the runner advance
 * `call_state`. No transcript content or PII is ever logged — the redaction guard on the
 * logger throws if a known content field appears.
 */
export const defaultStageHandlers: StageHandlers = Object.fromEntries(
  PIPELINE_STAGES.map((stage) => [
    stage,
    ({ logger }: StageContext): Promise<void> => {
      logger.info({ stage }, 'stage stub ran');
      return Promise.resolve();
    },
  ]),
) as StageHandlers;
