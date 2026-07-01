import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import { createRedisClient, RedisRateStore, RedisReplayStore } from '../http/index.js';
import { buildWebhookReceiverApp } from '../dialpad/webhook/receiver-app.js';
import { createPgIngestSink } from '../dialpad/webhook/sink.js';

/**
 * Webhook-receiver entrypoint (Task 3.2). Boots, confirms dependencies, then serves the public
 * Dialpad webhook on `PORT`: HS256-verified, replay/timestamp/rate-limited by the shared
 * middleware, minimizing each event to an allowlisted audit row + call_state seed and enqueuing
 * exactly one ingest job. No transcript fetch or model call in the request path. The Fastify
 * server keeps the process alive; SIGTERM/SIGINT drain and release every resource in order.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'webhook-receiver' });
  await assertDependenciesReady(config, logger);

  // Readiness guarantees these are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  // A normal (non-BullMQ) client backs the replay/rate stores.
  const storeConnection = createRedisClient(config.REDIS_URL);
  const replayStore = new RedisReplayStore(storeConnection);
  const rateStore = new RedisRateStore(storeConnection);

  const sink = createPgIngestSink({ pool, queue, config });
  // Registration throws CONFIG_MISSING_OR_INVALID if the signing or PII-hash secret is absent.
  const webhookApp = await buildWebhookReceiverApp({
    config,
    replayStore,
    rateStore,
    sink,
    logger,
  });

  await webhookApp.app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ node_env: config.NODE_ENV, port: config.PORT }, 'webhook-receiver listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'webhook-receiver shutting down');
    await webhookApp.app.close();
    await queue.close();
    await queueConnection.quit();
    await storeConnection.quit();
    await pool.end();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal).catch((err: unknown) => {
        process.stderr.write(`webhook-receiver shutdown error: ${String(err)}\n`);
        process.exit(1);
      });
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`webhook-receiver crashed: ${String(err)}\n`);
  process.exit(1);
});
