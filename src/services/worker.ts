import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { keepAlive } from '../boot/keepalive.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import { createPipelineWorker } from '../worker/worker.js';

/**
 * Worker entrypoint (Task 2.1). Boots, confirms dependencies, then consumes the BullMQ
 * pipeline queue and drives each call through the state machine. The kill switch gates
 * consumption without dropping queued jobs; on shutdown every resource is closed in order.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'worker' });
  await assertDependenciesReady(config, logger);

  // Readiness guarantees DATABASE_URL/REDIS_URL are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  // Separate connections: the worker's blocking BRPOPLPUSH must not tie up the queue's.
  const queueConnection = createQueueConnectionFromConfig(config);
  const workerConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  const worker = createPipelineWorker(config, pool, workerConnection, { logger });

  if (config.WORKER_KILL_SWITCH) {
    logger.warn(
      'WORKER_KILL_SWITCH is on — worker will NOT consume; queued jobs remain in Redis until it is turned off',
    );
  } else {
    // autorun:false, so start the processing loop explicitly. run() resolves on close.
    void worker.run().catch((err: unknown) => {
      logger.error({ error: String(err) }, 'worker run loop errored');
    });
    logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker consuming pipeline jobs');
  }

  logger.info({ node_env: config.NODE_ENV }, 'worker booted');
  await keepAlive();

  // Graceful shutdown: finish in-flight jobs, then release BullMQ/Redis/PG resources in order.
  logger.info('worker shutting down');
  await worker.close();
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`worker crashed: ${String(err)}\n`);
  process.exit(1);
});
