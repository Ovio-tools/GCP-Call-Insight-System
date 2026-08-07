import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool, createRawAppPool } from '../db/index.js';
import { requireRedactionConfig } from '../redaction/config.js';
import { buildServiceKeyProvider } from '../key-lifecycle/readiness.js';
import { createDialpadClient, RedisDualWindowLimiter } from '../dialpad/client/index.js';
import type { DialpadClient } from '../dialpad/client/index.js';
import { buildProductionStageHandlers } from '../pipeline/handlers.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue, type DelayedRetryQueue } from '../queue/pipeline-queue.js';
import { runPipeline } from '../pipeline/state-machine.js';
import { slaMinutesFor } from '../review-queue/sla.js';
import {
  checkUrlFor,
  createBackfillMonitor,
  httpPing,
  requireCheckUrl,
  type BackfillSignalUrls,
  type IntervalScheduler,
} from '../heartbeat/index.js';
import { httpPostAlert, requireAlertWebhookUrl, emitAlert } from '../alerting/index.js';
import {
  BackfillError,
  assertBackfillEnvironment,
  assertBackfillProcessingGates,
  createPgBackfillInlineIngest,
  createPgBackfillQueueIngest,
  deriveServiceTitanMatchingRequirement,
  loadSyntheticDialpadFixture,
  runBackfill,
} from '../backfill/index.js';

/**
 * Historical backfill entrypoint (Task 11.2). Pulls concluded historical calls (that predate
 * deployment) through the SAME idempotent seed → shared pipeline path. It is the highest-volume PII
 * move in the system, so it refuses loudly and early.
 *
 * Real backfill is PRODUCTION-ONLY, after every §0.2 consent gate is recorded; `staging` is limited
 * to synthetic-fixture smoke runs (`--synthetic-dialpad-fixture`); dev/test are refused. Guard order
 * (all BEFORE any Dialpad/Redis/pipeline dependency): loadConfig → requireRedactionConfig →
 * assertBackfillEnvironment → requireCheckUrl(backfill) → requireAlertWebhookUrl → connect app pool →
 * assertBackfillProcessingGates → build limiter + monitor → mode-specific deps → runBackfill.
 *
 * Usage:
 *   run-backfill --from <ISO> --to <ISO> [--resume <runId>] [--restart-from-scratch]
 *                [--match-keys] [--synthetic-dialpad-fixture <path>]
 */
interface BackfillArgs {
  fromMs: number;
  toMs: number;
  resume?: string;
  restartFromScratch: boolean;
  matchKeys: boolean;
  syntheticDialpadFixture?: string;
}

function parseArgs(argv: readonly string[]): BackfillArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fromRaw = get('--from');
  const toRaw = get('--to');
  if (fromRaw === undefined || toRaw === undefined) {
    throw new BackfillError('invalid_window', 'provide --from <ISO> and --to <ISO>');
  }
  const fromMs = Date.parse(fromRaw);
  const toMs = Date.parse(toRaw);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new BackfillError('invalid_window', '--from / --to must be parseable ISO timestamps');
  }
  if (fromMs >= toMs) {
    throw new BackfillError('invalid_window', '--from must be strictly before --to');
  }
  return {
    fromMs,
    toMs,
    ...(get('--resume') !== undefined ? { resume: get('--resume') as string } : {}),
    restartFromScratch: argv.includes('--restart-from-scratch'),
    matchKeys: argv.includes('--match-keys'),
    ...(get('--synthetic-dialpad-fixture') !== undefined
      ? { syntheticDialpadFixture: get('--synthetic-dialpad-fixture') as string }
      : {}),
  };
}

/** Derive the four distinct signal URLs from BACKFILL_CHECK_URL (validated distinct in the monitor). */
function deriveSignals(base: string): BackfillSignalUrls {
  const b = base.replace(/\/+$/, '');
  return { start: `${b}/start`, progress: `${b}/progress`, success: b, fail: `${b}/fail` };
}

const realScheduler: IntervalScheduler = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'backfill' });
  requireRedactionConfig(config);

  const args = parseArgs(process.argv.slice(2));

  // --match-keys: match-key write-back is a Phase-12 concern. Requiring the ST gate (via the
  // derivation) AND failing fast here guarantees no unimplemented path runs and the gate is never
  // silently bypassed.
  const writesMatchKeys = args.matchKeys;
  void deriveServiceTitanMatchingRequirement({ writesMatchKeys });
  if (writesMatchKeys) {
    throw new BackfillError(
      'match_keys_unsupported',
      'match-key write-back is not implemented until Task 12',
    );
  }

  // Pure environment guard FIRST — real backfill is production-only, staging is synthetic-only,
  // dev/test refused — before readiness or ANY database/Redis/pipeline dependency is constructed.
  const mode = assertBackfillEnvironment(config, {
    ...(args.syntheticDialpadFixture !== undefined
      ? { syntheticDialpadFixture: args.syntheticDialpadFixture }
      : {}),
  });
  requireCheckUrl(config, 'backfill');
  requireAlertWebhookUrl(config);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const base = checkUrlFor(config, 'backfill');
  if (base === undefined) throw new Error('BACKFILL_CHECK_URL is not set'); // requireCheckUrl guards this

  // Connect ONLY the app pool and confirm every §0.2 consent gate is recorded BEFORE building any
  // Redis / key / Dialpad / pipeline dependency (which would fetch/enqueue/process).
  const pool = createAppPool(config.DATABASE_URL);
  const monitor = createBackfillMonitor({
    signals: deriveSignals(base),
    component: 'backfill',
    ping: httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
    scheduler: realScheduler,
    now: () => Date.now(),
    logger,
    progressIntervalMs: config.BACKFILL_PROGRESS_INTERVAL_MS,
    stallThresholdMs: config.BACKFILL_STALL_THRESHOLD_MS,
  });

  const emitCheckpointAlert = async (context: Record<string, string>): Promise<void> => {
    await emitAlert(
      pool,
      config,
      { code: 'BACKFILL_CHECKPOINT_FAILED', processingState: 'degraded', context },
      { now: new Date(), logger, post: httpPostAlert() },
    );
  };

  try {
    await assertBackfillProcessingGates(pool, { writesMatchKeys });

    if (mode === 'production-real') {
      // Real Dialpad + shared pipeline queue + enqueue-ingest (the worker fleet processes async).
      await assertDependenciesReady(config, logger);
      const limiterConnection = createQueueConnectionFromConfig(config);
      const queueConnection = createQueueConnectionFromConfig(config);
      const queue = createPipelineQueue(config, queueConnection);
      try {
        const limiter = new RedisDualWindowLimiter(limiterConnection, {
          perSecond: config.DIALPAD_RATE_PER_SECOND,
          perMinute: config.DIALPAD_RATE_PER_MINUTE,
        });
        const client = createDialpadClient({ config, limiter, logger });
        await runBackfill({
          pool,
          config,
          logger,
          window: { fromMs: args.fromMs, toMs: args.toMs },
          client,
          ingestFor: (runId) => createPgBackfillQueueIngest({ pool, queue, config, runId }),
          monitor,
          emitCheckpointAlert,
          ...(args.resume !== undefined ? { resume: args.resume } : {}),
          ...(args.restartFromScratch ? { restartFromScratch: true } : {}),
        });
      } finally {
        await queue.close();
        await queueConnection.quit();
        await limiterConnection.quit();
      }
    } else {
      // Staging synthetic: fixture-backed Dialpad client + production stage handlers wired to it +
      // an IN-PROCESS processor (runPipeline per call). NO shared queue is constructed and the real
      // createDialpadClient is never built. The fixture guarantees ready transcripts, so the
      // fetch-transcript stage never enqueues a retry — a throwing stub queue enforces that.
      const client: DialpadClient = await loadSyntheticDialpadFixture(
        args.syntheticDialpadFixture as string,
      );
      const keyProvider = await buildServiceKeyProvider({ config, pool });
      const noEnqueueQueue: DelayedRetryQueue = {
        add: () => {
          throw new Error(
            'synthetic backfill must not enqueue (fixtures supply ready transcripts)',
          );
        },
      };
      // DB-B app pool (Task 8a): the in-process synthetic path runs the FULL pipeline here (no
      // worker), so it needs the raw store for the raw/vault stages. The production/queue mode
      // above only enqueues — raw/vault happen on the worker fleet — so it needs no raw pool.
      if (!config.RAW_DATABASE_URL) throw new Error('RAW_DATABASE_URL is not set');
      const rawPool = createRawAppPool(config.RAW_DATABASE_URL);
      try {
        const handlers = buildProductionStageHandlers({
          client,
          keyProvider,
          queue: noEnqueueQueue,
          config,
          rawPool,
        });
        await runBackfill({
          pool,
          config,
          logger,
          window: { fromMs: args.fromMs, toMs: args.toMs },
          client,
          ingestFor: (runId) =>
            createPgBackfillInlineIngest({
              pool,
              runId,
              runCall: (callId) =>
                runPipeline(pool, callId, logger, {
                  handlers,
                  slaMinutesFor: (reason) => slaMinutesFor(config, reason),
                }),
            }),
          monitor,
          emitCheckpointAlert,
          ...(args.resume !== undefined ? { resume: args.resume } : {}),
          ...(args.restartFromScratch ? { restartFromScratch: true } : {}),
        });
      } finally {
        await rawPool.end();
      }
    }
  } finally {
    monitor.stop();
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Only the error CLASS/reason, never its message: sanitized failure fields already went to the
    // structured log + the BACKFILL_CHECKPOINT_FAILED alert on the checkpoint path.
    const name =
      err instanceof BackfillError
        ? `BackfillError(${err.reason})`
        : err instanceof Error
          ? err.name
          : 'unknown error';
    process.stderr.write(`run-backfill failed (${name}); see the structured log / alert\n`);
    process.exit(1);
  });
}
