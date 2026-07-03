import { PIPELINE_STAGES, type PipelineStage } from '../pipeline/stages.js';

/**
 * The explicit DTO-key ↔ DB-stage mapping for the status surface (Task 7.3, plan §2).
 *
 * `call_state.current_stage` persists HYPHENATED canonical names (`PIPELINE_STAGES`); the DTO
 * exposes UNDERSCORED keys, and two differ in wording (`transcript-availability` →
 * `availability_check`, `verbatim-pii-scan` → `second_pii_scan`). This constant is the single
 * pairing, built FROM `PIPELINE_STAGES` so it can never silently drift: `DTO_META` is a
 * `Record<PipelineStage, …>`, so renaming/adding a pipeline stage fails to compile until this
 * file is updated, and {@link assertStageMappingCoversPipeline} re-checks at runtime.
 */

export interface StageNodeSpec {
  /** DTO key (underscored) rendered on the status page. */
  key: string;
  /** The `call_state.current_stage` value (hyphenated) this node counts. */
  dbStage: PipelineStage;
  /** Human label for the UI. */
  label: string;
}

const DTO_META: Record<PipelineStage, { key: string; label: string }> = {
  'metadata-pre-filter': { key: 'metadata_pre_filter', label: 'Metadata pre-filter' },
  'fetch-transcript': { key: 'fetch_transcript', label: 'Fetch transcript' },
  'transcript-availability': { key: 'availability_check', label: 'Availability check' },
  redact: { key: 'redact', label: 'Redact' },
  classify: { key: 'classify', label: 'Classify' },
  extract: { key: 'extract', label: 'Extract' },
  'verbatim-pii-scan': { key: 'second_pii_scan', label: 'Second PII scan' },
  store: { key: 'store', label: 'Store' },
  'mark-retention-eligible': { key: 'mark_retention_eligible', label: 'Mark retention-eligible' },
};

/** The 9 fixed pipeline nodes, in `PIPELINE_STAGES` order (always all rendered). */
export const STAGE_NODES: readonly StageNodeSpec[] = PIPELINE_STAGES.map((dbStage) => ({
  key: DTO_META[dbStage].key,
  dbStage,
  label: DTO_META[dbStage].label,
}));

/** DTO keys of the model stages, which render `paused` when a model kill switch is tripped. */
export const CLASSIFY_DTO_KEY = DTO_META['classify'].key;
export const EXTRACT_DTO_KEY = DTO_META['extract'].key;

const DB_TO_DTO = new Map<string, string>(STAGE_NODES.map((n) => [n.dbStage, n.key]));
const DTO_TO_DB = new Map<string, PipelineStage>(STAGE_NODES.map((n) => [n.key, n.dbStage]));

/** DTO key for a DB stage, or undefined for an unrecognized `current_stage` (the caller
 * logs sanitized and ignores it — never throws, so a future stage can't break the page). */
export function dbStageToDtoKey(dbStage: string): string | undefined {
  return DB_TO_DTO.get(dbStage);
}

/** DB stage for a DTO key, or undefined if unknown. */
export function dtoKeyToDbStage(key: string): PipelineStage | undefined {
  return DTO_TO_DB.get(key);
}

/**
 * Runtime guard: the mapping covers EXACTLY `PIPELINE_STAGES`. The compile-time
 * `Record<PipelineStage, …>` already forces this, but a test calls this so a drift (or a
 * hand-edit that duplicates/drops a stage) fails loudly rather than silently dropping a
 * node's count. Throws with the offending stages listed.
 */
export function assertStageMappingCoversPipeline(): void {
  const mapped = STAGE_NODES.map((n) => n.dbStage);
  const expected = [...PIPELINE_STAGES];
  const missing = expected.filter((s) => !mapped.includes(s));
  const extra = mapped.filter((s) => !expected.includes(s));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `status stage mapping drift — missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`,
    );
  }
}

/**
 * A fixed status-surface component (plan §2). `heartbeatComponent` is the
 * `component_heartbeats.component` value that feeds it. `periodicLiveness` marks the
 * components that emit a PERIODIC liveness heartbeat (worker + the crons) — only those get
 * stale-threshold logic. The webhook receiver is liveness-vs-activity split: an idle receiver
 * is still healthy, so a missing periodic heartbeat renders `unknown`, never `broken` from
 * inbound-traffic idleness.
 */
export interface ComponentNodeSpec {
  /** DTO key (underscored). */
  key: string;
  /** The `component_heartbeats.component` value (kebab-case, COMPONENT enum). */
  heartbeatComponent: string;
  label: string;
  /** True iff this component emits a periodic liveness heartbeat (stale threshold applies). */
  periodicLiveness: boolean;
}

/** The 4 fixed components, always rendered in this order. */
export const COMPONENT_NODES: readonly ComponentNodeSpec[] = [
  {
    key: 'webhook_receiver',
    heartbeatComponent: 'webhook-receiver',
    label: 'Webhook receiver',
    periodicLiveness: false,
  },
  { key: 'worker', heartbeatComponent: 'worker', label: 'Worker', periodicLiveness: true },
  {
    key: 'reconciliation_cron',
    heartbeatComponent: 'reconciliation-cron',
    label: 'Reconciliation cron',
    periodicLiveness: true,
  },
  {
    key: 'retention_cron',
    heartbeatComponent: 'retention-cron',
    label: 'Retention cron',
    periodicLiveness: true,
  },
];
