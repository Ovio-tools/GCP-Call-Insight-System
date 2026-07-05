import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import {
  createInternalApp,
  createRedisClient,
  oidcProviderFromConfig,
  RedisRateStore,
  RedisSessionStore,
} from '../http/index.js';
import { registerStatusRoutes } from '../status/routes.js';

/**
 * Status-surface entrypoint (Task 7.3). Boots the shared internal app (auth-by-default via
 * `createInternalApp`) and mounts the read-only `GET /status` (HTML) + `GET /status.json`
 * routes. Health and per-stage/component counts only — no content, no PII, no live per-call
 * animation. It reads the DB directly and degrades any missing signal to `unknown` rather
 * than failing the page.
 *
 * The external monitor stays the authoritative alerting source (CLAUDE.md §5); this surface
 * may DISPLAY health but does not replace the dead-man's switches.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'status-surface' });
  await assertDependenciesReady(config, logger);

  // Readiness guarantees DATABASE_URL/REDIS_URL are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);

  const app = await createInternalApp({
    config,
    authProvider: oidcProviderFromConfig(config),
    rateStore: new RedisRateStore(redis),
    sessionStore: new RedisSessionStore(redis, config.SESSION_TTL_MS),
    logger,
  });
  registerStatusRoutes(app, { pool, config, logger });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ node_env: config.NODE_ENV, port: config.PORT }, 'status-surface listening');
}

main().catch((err: unknown) => {
  process.stderr.write(`status-surface crashed: ${String(err)}\n`);
  process.exit(1);
});
