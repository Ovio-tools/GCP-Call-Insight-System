import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue, type PipelineJobData } from '../queue/pipeline-queue.js';
import type { Config } from '../config/schema.js';
import { EXTRACT_DISABLED_REASON } from '../pipeline/extract/handler.js';
import { findParkedCalls, requeueParkedCalls } from './requeue-parked-core.js';

/** The extract stage/marker pair the kill-switch park writes (see `parkStageDisabled`). */
const EXTRACT_PARK = { stage: 'extract', marker: EXTRACT_DISABLED_REASON } as const;

/**
 * Testable core: the call_ids parked at extract by the kill switch. Thin delegate to the
 * stage-parameterized `findParkedCalls` (see `requeue-parked-core.ts` for the semantics).
 */
export async function findParkedExtractCalls(pool: Pool): Promise<string[]> {
  return findParkedCalls(pool, EXTRACT_PARK);
}

/**
 * Find the parked extract calls and re-enqueue each. Thin delegate to the
 * stage-parameterized `requeueParkedCalls`; enqueue idempotency and the Redis-free test seam
 * are documented there.
 */
export async function requeueParkedExtractCalls(deps: {
  pool: Pool;
  queue: Queue<PipelineJobData>;
  config: Config;
}): Promise<number> {
  return requeueParkedCalls(deps, EXTRACT_PARK);
}

/**
 * Requeue-parked-extract entrypoint (Task 5.2, extract kill-switch recovery). A short-lived
 * one-shot: boot, find every call parked at extract by the kill switch, re-enqueue each,
 * log a COUNT only, release every resource, exit 0. Run this manually AFTER flipping
 * `EXTRACT_ENABLED` back on — reconciliation cannot rescue parked calls because their
 * `call_state` row already sits mid-pipeline (stage 'extract'), so the sweep treats them as
 * in-flight and skips them; this script is the documented recovery path.
 *
 * Safe to run repeatedly: the enqueue is call_id-keyed (idempotent), and `runPipeline`'s
 * terminal guards make a call that already moved past extract a no-op.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'requeue-parked-extract' });
  await assertDependenciesReady(config, logger);

  // Readiness guarantees DATABASE_URL/REDIS_URL are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);

  try {
    const requeued = await requeueParkedExtractCalls({ pool, queue, config });
    // Count only — call_id flows freely as a correlation id elsewhere, but the operational
    // signal here is simply how many parked calls were resumed. No content, no PII.
    logger.info({ requeued }, 'requeued parked extract calls');
  } finally {
    await queue.close();
    await queueConnection.quit();
    await pool.end();
  }
}

// Run only when invoked as the entrypoint (`node dist/scripts/requeue-parked-extract.js`),
// never when imported by a test for the testable core.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`requeue-parked-extract failed: ${String(err)}\n`);
    process.exit(1);
  });
}
