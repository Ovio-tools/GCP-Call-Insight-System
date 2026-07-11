import type { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import { enqueueReextract, type ReprocessQueue } from '../queue/pipeline-queue.js';
import { query } from '../db/sql.js';
import type { Config } from '../config/schema.js';

/**
 * One-shot RE-EXTRACT / recategorize backfill.
 *
 * Re-runs ONLY the extract stage on already-completed calls so a newly-added service_category (or
 * any extract-prompt change) is applied to history. There is no standing path to re-run a stage on
 * a COMPLETED call (the reprocess machinery is held-call-only), so this script does the one guarded
 * `completed → processing@extract` transition itself and enqueues a re-extract job; `runPipeline`
 * then resumes at extract and walks extract → second PII scan → store → mark-retention-eligible,
 * OVERWRITING `structured_knowledge` in place (upsert on call_id — no duplicates).
 *
 * Safety:
 *  - Scopes to calls whose redacted input still exists (a live `clean_transcripts` row) and whose
 *    `extraction_candidates` row was NOT hard-deleted by retention — an already-purged call cannot
 *    be re-extracted and is reported in the skipped count, never crashed.
 *  - The enqueue uses a run-scoped job id (never dedups against the retained completed base job).
 *  - If an enqueue fails, the call is reverted to completed so a re-run retries it (fail loud).
 *  - Deletion/model spend is unchanged: the extract stage still honors EXTRACT_ENABLED + the daily
 *    cost cap; this script only re-enqueues.
 *
 * Run AFTER the new category is deployed (enum + prompt + migration) and with EXTRACT_ENABLED on.
 * Usage: `node dist/scripts/reextract-recategorize.js [--dry-run] [--all | --categories=a,b,c]`.
 */

/** Default scope: the categories a grinder-pump call could realistically have been misfiled into.
 * Narrower than "all completed calls" to avoid re-running extraction on clearly-unrelated records
 * (each re-extract refreshes the whole record under the current prompt). `--all` widens to every
 * completed call; `--categories=` overrides with an explicit set. */
export const DEFAULT_REEXTRACT_CATEGORIES: readonly string[] = [
  'sump_pump_or_drainage',
  'sewer_or_septic',
  'other',
];

export interface ReextractScope {
  /** Restrict to completed calls whose CURRENT service_category is in this set. Empty = ALL. */
  categories?: readonly string[];
}

export interface ReextractSummary {
  /** Completed calls that are safely re-extractable (live clean transcript, candidate not purged). */
  eligible: number;
  /** Calls reset + enqueued for re-extraction. */
  enqueued: number;
  /** Selected but the guarded reset did not fire (state changed under us since selection). */
  skipped: number;
}

/**
 * Completed, still-re-extractable calls. Only calls whose redacted input is still present
 * (`clean_transcripts` not soft/hard-deleted) and whose `extraction_candidates` row was NOT
 * hard-deleted by retention. Optionally filtered to a set of current service_categories.
 */
export async function findReextractableCalls(
  pool: Pool,
  scope: ReextractScope = {},
): Promise<string[]> {
  const categories = scope.categories ?? [];
  const hasFilter = categories.length > 0;
  const rows = await query<{ call_id: string }>(
    pool,
    `SELECT cs.call_id
       FROM call_state cs
       JOIN structured_knowledge sk ON sk.call_id = cs.call_id
       JOIN clean_transcripts ct ON ct.call_id = cs.call_id
        AND ct.soft_deleted_at IS NULL AND ct.hard_deleted_at IS NULL
       LEFT JOIN extraction_candidates ec ON ec.call_id = cs.call_id
        AND ec.hard_deleted_at IS NOT NULL
      WHERE cs.status = 'completed'
        AND cs.current_stage = 'mark-retention-eligible'
        AND ec.call_id IS NULL
        ${hasFilter ? 'AND sk.service_category = ANY($1)' : ''}
      ORDER BY cs.call_id`,
    hasFilter ? [categories] : [],
  );
  return rows.map((r) => r.call_id);
}

/** Guarded reset of ONE completed call to processing@extract. Returns true iff it fired (the WHERE
 * guard makes a concurrently-moved call a no-op, so the caller counts it as skipped). */
async function resetToExtract(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ call_id: string }>(
    pool,
    `UPDATE call_state
        SET status = 'processing', current_stage = 'extract', updated_at = now()
      WHERE call_id = $1 AND status = 'completed' AND current_stage = 'mark-retention-eligible'
      RETURNING call_id`,
    [callId],
  );
  return rows.length === 1;
}

/** Revert a call we reset back to completed (on an enqueue failure) so a re-run retries it. */
async function revertToCompleted(pool: Pool, callId: string): Promise<void> {
  await query<{ call_id: string }>(
    pool,
    `UPDATE call_state
        SET status = 'completed', current_stage = 'mark-retention-eligible', updated_at = now()
      WHERE call_id = $1 AND status = 'processing' AND current_stage = 'extract'
      RETURNING call_id`,
    [callId],
  );
}

/**
 * Reset + enqueue each eligible call for re-extraction. Idempotent within a run (the run-scoped job
 * id) and across runs (scope requires `status='completed'`, so an in-flight reprocess is not
 * re-selected). `dryRun` reports the eligible count without any write or enqueue.
 */
export async function reextractCalls(
  deps: { pool: Pool; queue: ReprocessQueue; config: Config },
  opts: ReextractScope & { runId: string; dryRun?: boolean },
): Promise<ReextractSummary> {
  const callIds = await findReextractableCalls(deps.pool, opts);
  if (opts.dryRun) {
    return { eligible: callIds.length, enqueued: 0, skipped: 0 };
  }
  let enqueued = 0;
  let skipped = 0;
  for (const callId of callIds) {
    const didReset = await resetToExtract(deps.pool, callId);
    if (!didReset) {
      skipped += 1;
      continue;
    }
    try {
      await enqueueReextract(deps.queue, callId, deps.config, opts.runId);
      enqueued += 1;
    } catch (err) {
      // Keep the dataset consistent: put the call back to completed so a re-run retries it, then
      // fail loud (an enqueue failure is almost always Redis being unreachable).
      await revertToCompleted(deps.pool, callId);
      throw err;
    }
  }
  return { eligible: callIds.length, enqueued, skipped };
}

/** Parse the CLI flags: `--dry-run`, `--all` (every completed call), `--categories=a,b,c`. */
export function parseArgs(argv: readonly string[]): { dryRun: boolean; scope: ReextractScope } {
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const catsArg = argv.find((a) => a.startsWith('--categories='));
  if (catsArg) {
    const categories = catsArg
      .slice('--categories='.length)
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    return { dryRun, scope: { categories } };
  }
  // `--all` = no category filter (empty set); otherwise the safe default subset.
  return { dryRun, scope: { categories: all ? [] : DEFAULT_REEXTRACT_CATEGORIES } };
}

/**
 * Entrypoint: boot, select eligible completed calls, reset + enqueue each re-extraction, log COUNTS
 * only (never call_ids/PII), release every resource, exit 0. `--dry-run` reports and exits without
 * enqueuing. Run manually after deploying the new category, with EXTRACT_ENABLED on.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'reextract-recategorize' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const { dryRun, scope } = parseArgs(process.argv.slice(2));
  const pool = createAppPool(config.DATABASE_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  // A clean [A-Za-z0-9_-] run token so the re-extract job ids never collide with the base job.
  const runId = Date.now().toString(36);

  try {
    const summary = await reextractCalls({ pool, queue, config }, { ...scope, runId, dryRun });
    logger.info(
      {
        dry_run: dryRun,
        scope: scope.categories && scope.categories.length > 0 ? scope.categories : 'all',
        eligible: summary.eligible,
        enqueued: summary.enqueued,
        skipped: summary.skipped,
      },
      'reextract-recategorize complete',
    );
  } finally {
    await queue.close();
    await queueConnection.quit();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`reextract-recategorize crashed: ${String(err)}\n`);
    process.exit(1);
  });
}
