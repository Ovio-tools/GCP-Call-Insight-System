import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool, createRawAppPool } from '../db/index.js';
import { buildServiceKeyProvider } from '../key-lifecycle/readiness.js';
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
import { registerConsoleHomeRoute } from '../console/routes.js';
import { registerStatusRoutes } from '../status/routes.js';
import { registerKnowledgeRoutes } from '../knowledge/routes.js';
import { registerReviewRoutes } from '../review/routes.js';
import { registerNotesRoutes } from '../notes/routes.js';

/**
 * Combined console surface — the single sign-in entry point that mounts every internal surface on
 * ONE app under ONE session: the `GET /` home page plus the status, knowledge-base, review, and
 * note-review routes. Because all of them build on the same `createInternalApp` factory, share the
 * same auth/session/CSRF/rate-limit stack, and declare fully disjoint route paths (no module
 * registers a decorator/plugin/hook), they coexist here with no collision — proven by
 * `test/console/routes.test.ts`.
 *
 * The note-review surface (`/notes`) is mounted ONLY here: it has no single-surface service of its
 * own, so this file is its boot file (which is why its routes are registered under the `console`
 * surface in `test/security/_registry.ts`). It adds no dependency — it takes the same four the
 * knowledge surface does, and deliberately takes neither the raw pool, the key provider, the
 * restricted runner, nor the queue.
 *
 * It boots the UNION of the individual surfaces' dependencies: the primary pool (DB-A), the raw
 * store (DB-B), Redis (sessions + rate limits), the pipeline queue (review reprocess re-entry), the
 * envelope-encryption key provider + restricted DB-B runner (review's elevated raw/vault reveal),
 * and the redaction deny list (knowledge + review residual-egress guard). Signed-in users land on
 * `/` (the home), unlike the single-surface entrypoints which each land on their own view.
 *
 * Boot: `node dist/services/console-surface.js` (set `REVIEW_ELEVATED_ROLE` to enable reveal).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'console-surface' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.RAW_DATABASE_URL) throw new Error('RAW_DATABASE_URL is not set');
  if (!config.REDIS_URL) throw new Error('REDIS_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  // Raw transcripts + token vault live in the isolated raw store (DB-B); the review reveal reads
  // from rawPool and runs the restricted vault decrypt on it.
  const rawPool = createRawAppPool(config.RAW_DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL);
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  const keyProvider = await buildServiceKeyProvider({ config, pool });
  const runner = createRestrictedRunner(rawPool);
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  const app = await createInternalApp({
    config,
    authProvider: oidcProviderFromConfig(config),
    rateStore: new RedisRateStore(redis),
    sessionStore: new RedisSessionStore(redis, config.SESSION_TTL_MS),
    // The home page IS the '/' route here, so land signed-in users there.
    loginSuccessRedirect: '/',
    logger,
  });

  registerConsoleHomeRoute(app);
  registerStatusRoutes(app, { pool, config, logger });
  registerKnowledgeRoutes(app, { pool, config, denyTerms, logger });
  registerReviewRoutes(app, {
    pool,
    rawPool,
    config,
    logger,
    keyProvider,
    runner,
    queue,
    denyTerms,
  });
  registerNotesRoutes(app, { pool, config, denyTerms, logger });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ node_env: config.NODE_ENV, port: config.PORT }, 'console-surface listening');
}

main().catch((err: unknown) => {
  process.stderr.write(`console-surface crashed: ${String(err)}\n`);
  process.exit(1);
});
