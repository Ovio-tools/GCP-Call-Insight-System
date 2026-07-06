import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import {
  createInternalApp,
  createRedisClient,
  oidcProviderFromConfig,
  RedisRateStore,
  RedisSessionStore,
} from '../http/index.js';
import { registerKnowledgeRoutes } from '../knowledge/routes.js';

/**
 * Knowledge-base surface entrypoint (Task 10.1). Boots the shared internal app (auth-by-default via
 * `createInternalApp`) and mounts the read-only knowledge routes: `GET /knowledge` (HTML) +
 * `/knowledge.json` (paginated view), and `/knowledge/export.csv` + `/knowledge/export.json`
 * (all filtered rows, capped). Reads ONLY `structured_knowledge`; no content, no PII, no sentiment,
 * no model metadata leaves the process. The deny list feeds the value-level residual egress guard,
 * the same source the review surface uses.
 *
 * Boot: `node dist/services/knowledge-surface.js`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'knowledge-surface' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  const app = await createInternalApp({
    config,
    authProvider: oidcProviderFromConfig(config),
    rateStore: new RedisRateStore(redis),
    sessionStore: new RedisSessionStore(redis, config.SESSION_TTL_MS),
    logger,
  });
  registerKnowledgeRoutes(app, { pool, config, denyTerms, logger });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ node_env: config.NODE_ENV, port: config.PORT }, 'knowledge-surface listening');
}

main().catch((err: unknown) => {
  process.stderr.write(`knowledge-surface crashed: ${String(err)}\n`);
  process.exit(1);
});
