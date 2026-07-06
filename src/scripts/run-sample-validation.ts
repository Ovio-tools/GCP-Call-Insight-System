import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { requireRedactionConfig } from '../redaction/config.js';
import { buildServiceKeyProvider } from '../key-lifecycle/readiness.js';
import { createDialpadClient, RedisDualWindowLimiter } from '../dialpad/client/index.js';
import { buildProductionStageHandlers } from '../pipeline/handlers.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import { runPipeline } from '../pipeline/state-machine.js';
import { slaMinutesFor } from '../review-queue/sla.js';
import {
  assertProcessingGates,
  assertStagingResources,
  runSampleValidation,
  type SampleSelectionInput,
} from '../sample-validation/index.js';

/**
 * Sample-validation harness entrypoint (Task 11.1). The ONE consented staging exception: run a small
 * batch of REAL calls through the full pipeline and emit a PII-free side-by-side review report.
 *
 * It refuses unless: NODE_ENV is staging, no configured resource resolves to a production host, and
 * every §0.2 processing gate (plus the ServiceTitan matching consent when `--servicetitan` is set)
 * is recorded in `consent_gates`. Those guards run BEFORE any Dialpad fetch, model call, or enqueue.
 *
 * Usage:
 *   node dist/scripts/run-sample-validation.js --calls <id1,id2,...> [--servicetitan] [--out <path>]
 *   node dist/scripts/run-sample-validation.js --size <n>          [--servicetitan] [--out <path>]
 */
function parseArgs(argv: readonly string[]): {
  selection: SampleSelectionInput;
  exercisesServiceTitan: boolean;
  out: string | undefined;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const calls = get('--calls');
  const size = get('--size');
  const out = get('--out');
  const exercisesServiceTitan = argv.includes('--servicetitan');

  let selection: SampleSelectionInput;
  if (calls !== undefined) {
    selection = { callIds: calls.split(',').map((c) => c.trim()) };
  } else if (size !== undefined) {
    selection = { sampleSize: Number(size) };
  } else {
    throw new Error('provide --calls <id1,id2,...> or --size <n>');
  }
  return { selection, exercisesServiceTitan, out };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'sample-validation' });
  requireRedactionConfig(config);

  // Pure guards FIRST — staging-only + no production database/queue/endpoint — before readiness or
  // ANY database/Redis connection is constructed, so a misconfigured run never touches infra.
  assertStagingResources(config);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const { selection, exercisesServiceTitan, out } = parseArgs(process.argv.slice(2));
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  // Connect ONLY the screened staging database and confirm every §0.2 consent gate is recorded
  // BEFORE building any Redis / key / Dialpad / pipeline dependency (which would fetch/enqueue).
  const pool = createAppPool(config.DATABASE_URL);
  try {
    await assertProcessingGates(pool, { requireServiceTitanMatching: exercisesServiceTitan });

    // Gates cleared: NOW verify Redis reachability and build the real pipeline dependencies.
    await assertDependenciesReady(config, logger);
    const queueConnection = createQueueConnectionFromConfig(config);
    const limiterConnection = createQueueConnectionFromConfig(config);
    const queue = createPipelineQueue(config, queueConnection);

    try {
      // Real stage handlers — the FULL existing pipeline, never duplicated logic. runSampleValidation
      // re-runs the same guards + gate check (idempotent) before it exercises any of these.
      const keyProvider = await buildServiceKeyProvider({ config, pool });
      const limiter = new RedisDualWindowLimiter(limiterConnection, {
        perSecond: config.DIALPAD_RATE_PER_SECOND,
        perMinute: config.DIALPAD_RATE_PER_MINUTE,
      });
      const client = createDialpadClient({ config, limiter, logger });
      const handlers = buildProductionStageHandlers({ client, keyProvider, queue, config });

      const result = await runSampleValidation(
        pool,
        config,
        { selection, exercisesServiceTitan },
        {
          runCall: (p, callId, lg) =>
            runPipeline(p, callId, lg, {
              handlers,
              slaMinutesFor: (reason) => slaMinutesFor(config, reason),
            }),
          denyTerms,
          logger,
        },
      );

      const json = JSON.stringify(result, null, 2);
      if (out !== undefined) {
        await writeFile(out, json, 'utf8');
        // Count only — the report itself is PII-free but the log line stays sanitized.
        logger.info({ calls: result.callIds.length, out }, 'sample-validation report written');
      } else {
        process.stdout.write(`${json}\n`);
        logger.info({ calls: result.callIds.length }, 'sample-validation report emitted');
      }
    } finally {
      await queue.close();
      await queueConnection.quit();
      await limiterConnection.quit();
    }
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`run-sample-validation failed: ${String(err)}\n`);
    process.exit(1);
  });
}
