import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';
import type { Config } from '../config/schema.js';
import type { JsonValue } from '../db/types.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import {
  type HeartbeatPinger,
  checkUrlFor,
  httpPing,
  pingSuccess,
  requireCheckUrl,
} from '../heartbeat/index.js';
import {
  createAnthropicClassifyClient,
  createAnthropicExtractClient,
} from '../anthropic/client.js';
import { listAcceptedExamples } from '../db/repositories/labeled-examples-repo.js';
import { insertEvaluationReport } from '../db/repositories/evaluation-reports-repo.js';
import type { EvaluationMode } from '../db/schemas/evaluation-reports.js';
import { syncLabeledExamples } from '../evaluation/sync.js';
import {
  type ClassifyPredictor,
  type EvaluationReport,
  type ExtractPredictor,
  runEvaluation,
} from '../evaluation/run-evaluation.js';
import { createClassifyPredictor, createExtractPredictor } from '../evaluation/predictors.js';
import { PII_GATE_VERSION } from '../evaluation/version.js';

/**
 * The periodic accuracy check (Task 6.3): `npm run eval:run` / the weekly Railway cron. Gate on
 * `EVALUATION_RUN_ENABLED`; a genuine run syncs labels (safety net), evaluates the current-version
 * corpus with the LIVE predictors, persists ONE PII-free `evaluation_reports` row (`mode='live'`),
 * and pings the external check ONLY on a complete live run. In staging/production an
 * `EVALUATION_RUN_ENABLED=true` + `EVALUATION_LIVE_MODE=false` misconfig is fail-fast
 * `CONFIG_MISSING_OR_INVALID` — before any sync/eval/insert/ping — so the check can never write a
 * non-live `test_stub` report or ping green without calling the models. The `test_stub` path is
 * reachable ONLY via injected test deps or the local `--stub` flag; `--dry-run` prints and persists
 * nothing (never a persisted `mode`).
 */

const MONITORED_ENVS: ReadonlySet<Config['NODE_ENV']> = new Set(['staging', 'production']);

export interface EvaluationRunJobDeps {
  config: Config;
  logger: Logger;
  now: () => Date;
  ping: HeartbeatPinger;
  denyTerms: readonly string[];
  /** The predictors + their authoritative mode. Live predictors ⇒ `mode='live'`; CI/local stubs ⇒
   * `mode='test_stub'`. */
  predictors: {
    mode: EvaluationMode;
    classifyPredictor: ClassifyPredictor;
    extractPredictor: ExtractPredictor;
  };
  /** Injectable label-sync safety net (defaults to `syncLabeledExamples`). */
  syncLabels?: () => Promise<void>;
  /** CLI-only preview: compute + return the report but persist NOTHING and never ping. */
  dryRun?: boolean;
}

/**
 * Run one evaluation job. Returns the computed report, or `null` when disabled. A genuine run is
 * `sync → list → evaluate → persist(mode) → ping-on-complete-live`; a dry run stops before persist.
 */
export async function runEvaluationJob(
  pool: Pool,
  deps: EvaluationRunJobDeps,
): Promise<EvaluationReport | null> {
  const { config, logger } = deps;

  if (!config.EVALUATION_RUN_ENABLED) {
    logger.info(
      { component: 'evaluation-cron' },
      'evaluation run disabled — skipped (no report, no ping)',
    );
    return null;
  }

  // Fail-fast: the periodic accuracy check MUST be live in staging/production. Never write a
  // non-live report or ping green without calling the models. Thrown BEFORE any sync/eval/insert/ping.
  if (MONITORED_ENVS.has(config.NODE_ENV) && !config.EVALUATION_LIVE_MODE) {
    throw new ConfigError(
      ['EVALUATION_LIVE_MODE'],
      `${CONFIG_ERROR_CODE}: EVALUATION_LIVE_MODE must be true in ${config.NODE_ENV} — the periodic accuracy check must call the real models, not a stub`,
    );
  }

  // Safety-net sync (the reconciliation cron already runs it every 15 min).
  const syncLabels =
    deps.syncLabels ??
    (async () => {
      await syncLabeledExamples(pool, { denyTerms: deps.denyTerms, logger });
    });
  await syncLabels();

  const examples = await listAcceptedExamples(pool);
  const report = await runEvaluation({
    examples,
    classifyPredictor: deps.predictors.classifyPredictor,
    extractPredictor: deps.predictors.extractPredictor,
    now: deps.now(),
    logger,
  });

  logger.info(
    {
      component: 'evaluation-cron',
      mode: deps.predictors.mode,
      status: report.status,
      skip_reason: report.skip_reason,
      examples_evaluated: report.examples_evaluated,
      examples_skipped: report.examples_skipped,
      by_group: report.byGroup,
    },
    'evaluation run complete',
  );

  if (deps.dryRun) {
    logger.info({ component: 'evaluation-cron' }, 'dry-run — report computed, nothing persisted');
    return report;
  }

  await insertEvaluationReport(pool, {
    evalSetVersion: report.eval_set_version,
    piiGateVersion: PII_GATE_VERSION,
    mode: deps.predictors.mode,
    status: report.status,
    skipReason: report.skip_reason,
    generatedAt: report.generated_at,
    // JSON round-trip to a plain JsonValue (the metric objects carry readonly-array coverage
    // metadata that is not structurally a mutable JsonValue). Grouped counts only — no content.
    summary: JSON.parse(
      JSON.stringify({ byTaskType: report.byTaskType, byGroup: report.byGroup }),
    ) as JsonValue,
    failures: report.failures,
    examplesEvaluated: report.examples_evaluated,
    examplesSkipped: report.examples_skipped,
  });

  // Ping ONLY a complete LIVE run with ≥1 example evaluated — a partial/skipped/stub run inserts a
  // non-authoritative report and does NOT ping; the missed external check is the alert.
  if (
    deps.predictors.mode === 'live' &&
    report.status === 'complete' &&
    report.examples_evaluated >= 1
  ) {
    await pingSuccess({
      component: 'evaluation-cron',
      url: checkUrlFor(config, 'evaluation-cron'),
      logger,
      ping: deps.ping,
    });
  }
  return report;
}

/** Deterministic offline stub predictors (`--stub` / local only): echo the label, so a local smoke
 * test runs without a network call and produces a `mode='test_stub'` (non-authoritative) report. */
function stubPredictors(): {
  mode: 'test_stub';
  classifyPredictor: ClassifyPredictor;
  extractPredictor: ExtractPredictor;
} {
  return {
    mode: 'test_stub',
    classifyPredictor: (ex) =>
      Promise.resolve({ status: 'ok', value: ex.expected_output as { bucket: string } }),
    extractPredictor: (ex) =>
      Promise.resolve({
        status: 'ok',
        value: ex.expected_output as {
          call_intent: string;
          service_category: string;
          urgency: string;
          sentiment: string;
        },
      }),
  };
}

/**
 * Evaluation-cron entrypoint. Short-lived Railway cron (weekly, Mon 06:00 UTC): boots, fail-fast
 * requires its OWN check URL in staging/prod, evaluates, and exits so Railway re-invokes on
 * schedule. Live predictors record `model_invocations` + honor the cost cap/kill switch. CLI flags:
 * `--stub` (local, non-authoritative) and `--dry-run` (print, persist nothing).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'evaluation-cron' });
  // Production/staging must not run an unmonitored accuracy check: fail fast, naming the variable.
  requireCheckUrl(config, 'evaluation-cron');
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const argv = process.argv.slice(2);
  const stub = argv.includes('--stub');
  const dryRun = argv.includes('--dry-run');
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const predictors = stub
      ? stubPredictors()
      : {
          mode: 'live' as const,
          classifyPredictor: createClassifyPredictor({
            pool,
            config,
            getModel: () => createAnthropicClassifyClient(config),
            logger,
          }),
          extractPredictor: createExtractPredictor({
            pool,
            config,
            getModel: () => createAnthropicExtractClient(config),
            logger,
          }),
        };
    await runEvaluationJob(pool, {
      config,
      logger,
      now: () => new Date(),
      ping: httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
      denyTerms,
      predictors,
      dryRun,
    });
  } finally {
    await pool.end();
  }
}

// Auto-run only as the cron entrypoint, never when a test imports runEvaluationJob.
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    const name = err instanceof Error ? err.name : 'unknown error';
    process.stderr.write(`evaluation-cron failed (${name}); see the structured log\n`);
    process.exit(1);
  });
}
