import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue, enqueueCall, type PipelineJobData } from '../queue/pipeline-queue.js';
import type { Config } from '../config/schema.js';
import { query } from '../db/sql.js';

/**
 * Testable core: the call_ids parked at classify by the kill switch.
 *
 * A call is "parked" iff BOTH hold:
 *  - its `call_state` is still `status='processing'` at `current_stage='classify'` (the
 *    kill-switch park leaves the row exactly there — `parkDisabled` never advances it), and
 *  - its LATEST `processing_log` row for the classify stage is the `classify_disabled`
 *    deferred marker.
 *
 * "LATEST" is load-bearing: a call parked earlier and later genuinely processed has a NEWER
 * classify log row whose reason is not `classify_disabled`, and must NOT be requeued. The
 * `DISTINCT ON (call_id) … ORDER BY created_at DESC, id DESC` tie-break mirrors exactly the
 * ordering `parkDisabled` uses to decide idempotency, so the two agree on which row is latest.
 */
export async function findParkedClassifyCalls(pool: Pool): Promise<string[]> {
  const rows = await query<{ call_id: string }>(
    pool,
    `SELECT cs.call_id
       FROM call_state cs
       JOIN LATERAL (
         -- The id DESC tie-break assumes distinct created_at per row (processing_log.id is a
         -- random uuid, not monotonic, so it cannot itself order same-timestamp rows). This
         -- holds because the park marker and any later genuine classify log are always written
         -- in separate transactions, so their created_at (transaction_timestamp) differ.
         -- This per-call LATERAL subquery rides the existing processing_log_call_id_idx access
         -- path and is acceptable for this bounded, one-shot operational script.
         SELECT pl.detail->>'reason' AS reason
           FROM processing_log pl
          WHERE pl.call_id = cs.call_id AND pl.stage = 'classify'
          ORDER BY pl.created_at DESC, pl.id DESC
          LIMIT 1
       ) latest ON true
      WHERE cs.status = 'processing'
        AND cs.current_stage = 'classify'
        AND latest.reason = 'classify_disabled'
      ORDER BY cs.call_id`,
  );
  return rows.map((r) => r.call_id);
}

/**
 * Find the parked classify calls and re-enqueue each. Enqueue is idempotent — `enqueueCall`
 * keys the job by `jobIdForCall(callId)`, so a double run (or a call that already has a live
 * job) collapses to a single job. Returns the count re-enqueued. Kept separate from the CLI
 * so tests exercise it without a real Redis.
 */
export async function requeueParkedClassifyCalls(deps: {
  pool: Pool;
  queue: Queue<PipelineJobData>;
  config: Config;
}): Promise<number> {
  const callIds = await findParkedClassifyCalls(deps.pool);
  for (const callId of callIds) {
    await enqueueCall(deps.queue, callId, deps.config);
  }
  return callIds.length;
}

/**
 * Requeue-parked-classify entrypoint (Task 9, classify kill-switch recovery). A short-lived
 * one-shot: boot, find every call parked at classify by the kill switch, re-enqueue each,
 * log a COUNT only, release every resource, exit 0. Run this manually AFTER flipping
 * `CLASSIFY_ENABLED` back on — reconciliation cannot rescue parked calls because their
 * `call_state` row already sits mid-pipeline (stage 'classify'), so the sweep treats them as
 * in-flight and skips them; this script is the documented recovery path.
 *
 * Safe to run repeatedly: the enqueue is call_id-keyed (idempotent), and `runPipeline`'s
 * terminal guards make a call that already moved past classify a no-op.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'requeue-parked-classify' });
  await assertDependenciesReady(config, logger);

  // Readiness guarantees DATABASE_URL/REDIS_URL are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);

  try {
    const requeued = await requeueParkedClassifyCalls({ pool, queue, config });
    // Count only — call_id flows freely as a correlation id elsewhere, but the operational
    // signal here is simply how many parked calls were resumed. No content, no PII.
    logger.info({ requeued }, 'requeued parked classify calls');
  } finally {
    await queue.close();
    await queueConnection.quit();
    await pool.end();
  }
}

// Run only when invoked as the entrypoint (`node dist/scripts/requeue-parked-classify.js`),
// never when imported by a test for the testable core.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`requeue-parked-classify failed: ${String(err)}\n`);
    process.exit(1);
  });
}
