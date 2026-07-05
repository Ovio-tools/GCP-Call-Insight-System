import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { utcDay } from '../model/cost.js';
import { REMEDIATION_CATALOG } from '../failure-model/index.js';
import type { AlertEventRow } from '../db/schemas/alert-events.js';
import {
  countByProcessingStage,
  countCompletedBetween,
} from '../db/repositories/call-state-repo.js';
import { type HeldReasonCount, countOpenByReason } from '../db/repositories/review-queue-repo.js';
import { countUncleared } from '../db/repositories/dead-letter-repo.js';
import { getDay } from '../db/repositories/daily-cost-usage-repo.js';
import { listHeartbeats } from '../db/repositories/component-heartbeats-repo.js';
import { latestActive } from '../db/repositories/alert-events-repo.js';
import type { ComponentHeartbeatRow } from '../db/schemas/component-heartbeats.js';
import {
  CLASSIFY_DTO_KEY,
  COMPONENT_NODES,
  EXTRACT_DTO_KEY,
  STAGE_NODES,
  dbStageToDtoKey,
} from './stages.js';
import type {
  ComponentNode,
  LatestIssue,
  NodeState,
  PipelineState,
  StageNode,
  StatusDTO,
} from './dto.js';

/**
 * Build the status DTO (Task 7.3, plan §3). EVERY signal is wrapped so an error or absence
 * yields `unknown`/`null`, never a 500 — a broken component must not break the page that
 * reports on it. The aggregation NEVER selects transcript text, vault, clean-transcript
 * bodies, `customer_language`, phone, or name: only counts, states, timestamps, budget
 * numbers, and catalog-derived (PII-incapable) issue text are read.
 *
 * `null` vs `0` is deliberate: a thrown query → `null` (rendered `unknown`); a query that
 * succeeded with no rows → `0`.
 */
export interface BuildStatusDeps {
  config: Config;
  now: Date;
  logger: Logger;
}

/** Reduce a throwable to a coarse, log-safe token — never a raw message (could carry a
 * query fragment). Mirrors the heartbeat ping sanitizer's philosophy. */
function coarse(err: unknown): string {
  return err instanceof Error ? err.name || err.constructor.name : typeof err;
}

/** Run a signal fetch; on any throw, sanitized-log and return the failure fallback. */
async function attempt<T>(
  logger: Logger,
  signal: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ signal }, `status signal failed (${coarse(err)})`);
    return fallback;
  }
}

/** The DTO stage key an alert points at, from its sanitized `context.stage`, or undefined. */
function alertStageKey(row: AlertEventRow | undefined): string | undefined {
  if (!row) return undefined;
  const snapshot = row.failure_snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return undefined;
  const context = (snapshot as { context?: unknown }).context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const stage = (context as { stage?: unknown }).stage;
  return typeof stage === 'string' ? dbStageToDtoKey(stage) : undefined;
}

function staleThresholdMs(config: Config, componentKey: string): number {
  switch (componentKey) {
    case 'worker':
      return config.WORKER_HEARTBEAT_STALE_MS;
    case 'reconciliation_cron':
      return config.RECONCILIATION_HEARTBEAT_STALE_MS;
    case 'retention_cron':
      return config.RETENTION_HEARTBEAT_STALE_MS;
    default:
      return Number.POSITIVE_INFINITY; // never stale from idleness (webhook receiver)
  }
}

export async function buildStatus(pool: Pool, deps: BuildStatusDeps): Promise<StatusDTO> {
  const { config, now, logger } = deps;
  const day = utcDay(now);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  // --- fetch every signal independently, each degrading to a failure fallback ---
  const STAGE_FAIL = Symbol('stage-fail');
  const stageCounts = await attempt<Map<string, number> | typeof STAGE_FAIL>(
    logger,
    'stage_counts',
    async () => {
      const rows = await countByProcessingStage(pool);
      const map = new Map<string, number>();
      for (const r of rows) {
        const key = dbStageToDtoKey(r.current_stage);
        if (key === undefined) {
          // An unknown/unrecognized current_stage must not break the page — log sanitized
          // (the stage NAME is a safe controlled identifier, never content) and ignore it.
          logger.warn(
            { signal: 'stage_counts', current_stage: r.current_stage },
            'unrecognized current_stage — ignored',
          );
          continue;
        }
        map.set(key, (map.get(key) ?? 0) + r.count);
      }
      return map;
    },
    STAGE_FAIL,
  );
  const stageCountsFailed = stageCounts === STAGE_FAIL;
  const stageMap: Map<string, number> = stageCountsFailed ? new Map<string, number>() : stageCounts;

  const heldByReason = await attempt<HeldReasonCount[] | null>(
    logger,
    'held_by_reason',
    () => countOpenByReason(pool),
    null,
  );
  const heldTotal = heldByReason === null ? null : heldByReason.reduce((s, r) => s + r.count, 0);

  const deadLetterCount = await attempt<number | null>(
    logger,
    'dead_letter',
    () => countUncleared(pool),
    null,
  );

  const processedToday = await attempt<number | null>(
    logger,
    'processed_today',
    () => countCompletedBetween(pool, { from: dayStart, to: dayEnd }),
    null,
  );

  const SPEND_FAIL = Symbol('spend-fail');
  const spendResult = await attempt<number | typeof SPEND_FAIL>(
    logger,
    'spend',
    async () => {
      const row = await getDay(pool, day);
      return row ? Number(row.estimated_cost) : 0; // no row (query OK) → 0
    },
    SPEND_FAIL,
  );
  const spentUsd = spendResult === SPEND_FAIL ? null : spendResult;

  const heartbeats = await attempt<ComponentHeartbeatRow[] | null>(
    logger,
    'heartbeats',
    () => listHeartbeats(pool),
    null,
  );

  const ALERT_FAIL = Symbol('alert-fail');
  const alertResult = await attempt<AlertEventRow | undefined | typeof ALERT_FAIL>(
    logger,
    'latest_issue',
    () => latestActive(pool),
    ALERT_FAIL,
  );
  const alertQueryOk = alertResult !== ALERT_FAIL;
  const latestRow = alertResult === ALERT_FAIL ? undefined : alertResult;

  // --- model pause, PER STAGE: a stage is paused when its own kill switch is off OR the daily
  // hard cap is reached; false only when its flag is on and spend is known under cap; null
  // (unknown) when the flag is on but the cost lookup failed. classify + extract each have their
  // own kill switch (CLASSIFY_ENABLED / EXTRACT_ENABLED), so they can pause independently. ---
  const cap = config.DAILY_MODEL_COST_CAP_USD;
  const capReached: boolean | null = spentUsd === null ? null : spentUsd >= cap;
  const stagePaused = (enabled: boolean): boolean | null => (enabled ? capReached : true);
  const classifyPaused = stagePaused(config.CLASSIFY_ENABLED);
  const extractPaused = stagePaused(config.EXTRACT_ENABLED);
  // Summary flag: known-true if EITHER stage is known-paused; false only when BOTH are known
  // not-paused; null otherwise (some signal unknown, none known-true) — never a false guess.
  let modelPaused: boolean | null;
  if (classifyPaused === true || extractPaused === true) {
    modelPaused = true;
  } else if (classifyPaused === false && extractPaused === false) {
    modelPaused = false;
  } else {
    modelPaused = null;
  }

  // --- latest issue + which stage (if any) it breaks/degrades ---
  const brokenStageKey = latestRow?.severity === 'critical' ? alertStageKey(latestRow) : undefined;
  const degradedStageKey =
    latestRow && latestRow.severity !== 'critical' ? alertStageKey(latestRow) : undefined;

  let latestIssue: LatestIssue | null = null;
  if (latestRow) {
    const entry = REMEDIATION_CATALOG[latestRow.error_code as keyof typeof REMEDIATION_CATALOG];
    latestIssue = {
      error_code: latestRow.error_code,
      root_cause_category: latestRow.root_cause_category,
      severity: latestRow.severity,
      // Catalog impact is a single, PII-incapable sentence. Fall back to the code alone for an
      // (unexpected) uncatalogued code rather than throwing.
      summary: entry ? entry.impact : latestRow.error_code,
      runbook_ref: entry ? entry.runbookRef : 'runbook#unknown',
      at: latestRow.created_at.toISOString(),
    };
  }

  // --- pipeline stage nodes (fixed 9) ---
  const pausedForKey = (key: string): boolean | null => {
    if (key === CLASSIFY_DTO_KEY) return classifyPaused;
    if (key === EXTRACT_DTO_KEY) return extractPaused;
    return false; // non-model stages never pause on a model kill switch
  };
  function stageState(key: string, count: number | null): NodeState {
    if (count === null) return 'unknown';
    if (brokenStageKey === key) return 'broken';
    const paused = pausedForKey(key);
    if (paused === true) return 'paused';
    if (paused === null) return 'unknown';
    if (degradedStageKey === key) return 'degraded';
    return count > 0 ? 'healthy' : 'idle';
  }
  const pipelineNodes: StageNode[] = STAGE_NODES.map((node) => {
    const count = stageCountsFailed ? null : (stageMap.get(node.key) ?? 0);
    return { key: node.key, label: node.label, state: stageState(node.key, count), count };
  });

  // --- components (fixed 4) ---
  const hbByComponent = new Map((heartbeats ?? []).map((h) => [h.component, h]));
  const components: ComponentNode[] = COMPONENT_NODES.map((spec) => {
    const row = hbByComponent.get(spec.heartbeatComponent);
    let state: NodeState;
    let lastRunAt: string | null;
    if (heartbeats === null) {
      state = 'unknown';
      lastRunAt = null;
    } else if (!row) {
      // No liveness signal at all → unknown (never `broken` from idleness).
      state = 'unknown';
      lastRunAt = null;
    } else {
      lastRunAt = row.last_run_at.toISOString();
      if (row.last_status === 'degraded') {
        state = 'degraded';
      } else if (
        spec.periodicLiveness &&
        now.getTime() - row.last_run_at.getTime() > staleThresholdMs(config, spec.key)
      ) {
        state = 'broken';
      } else {
        state = 'healthy';
      }
    }
    return { key: spec.key, label: spec.label, state, last_run_at: lastRunAt };
  });

  // --- overall pipeline state ---
  const coreSignalsAvailable =
    processedToday !== null || heldTotal !== null || deadLetterCount !== null || !stageCountsFailed;
  let pipelineState: PipelineState;
  if (latestIssue) {
    pipelineState = latestIssue.severity === 'critical' ? 'broken' : 'degraded';
  } else if (modelPaused === true) {
    pipelineState = 'paused';
  } else if (alertQueryOk && coreSignalsAvailable) {
    pipelineState = 'running';
  } else {
    // Required summary signals unavailable and no stronger broken/degraded/paused signal.
    pipelineState = 'unknown';
  }

  return {
    generated_at: now.toISOString(),
    summary: {
      pipeline_state: pipelineState,
      calls_processed_today: processedToday,
      calls_held_for_review: heldTotal,
      held_by_reason: heldByReason,
      dead_letter_count: deadLetterCount,
      spend: { spent_usd: spentUsd, budget_usd: cap, model_paused: modelPaused },
      components_last_run: components.map((c) => ({
        component: c.key,
        last_run_at: c.last_run_at,
        state: c.state,
      })),
      latest_issue: latestIssue,
    },
    pipeline_nodes: pipelineNodes,
    components,
  };
}
