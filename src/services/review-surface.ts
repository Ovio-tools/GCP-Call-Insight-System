import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { keyProviderFromConfig } from '../crypto/index.js';
import { createRestrictedRunner } from '../db/restricted/restricted-context.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import {
  createInternalApp,
  createRedisClient,
  oidcProviderFromConfig,
  RedisRateStore,
  RedisSessionStore,
} from '../http/index.js';
import { registerReviewRoutes } from '../review/routes.js';

/**
 * Review & admin surface entrypoint (Task 6.2). Boots the shared internal app (auth-by-default via
 * `createInternalApp`) and mounts the read-only `GET /review` list + detail and the CSRF-enforced
 * `POST` action / elevated `reveal-raw` routes. Reuses `config.PORT`.
 *
 * Beyond the status-surface boot it also wires: the envelope-encryption key provider and the
 * restricted-role runner (for the elevated raw/vault reveal), the pipeline queue (for reprocess
 * re-entry), and the redaction deny list (for the detail's value-level residual guard).
 *
 * Boot: `node dist/services/review-surface.js` (set `REVIEW_ELEVATED_ROLE` to enable reveal).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'review-surface' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  const keyProvider = keyProviderFromConfig(config);
  const runner = createRestrictedRunner(pool);
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  const app = await createInternalApp({
    config,
    authProvider: oidcProviderFromConfig(config),
    rateStore: new RedisRateStore(redis),
    sessionStore: new RedisSessionStore(redis, config.SESSION_TTL_MS),
    logger,
  });
  registerReviewRoutes(app, { pool, config, logger, keyProvider, runner, queue, denyTerms });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ node_env: config.NODE_ENV, port: config.PORT }, 'review-surface listening');
}

main().catch((err: unknown) => {
  process.stderr.write(`review-surface crashed: ${String(err)}\n`);
  process.exit(1);
});
