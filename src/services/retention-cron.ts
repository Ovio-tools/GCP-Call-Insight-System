import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';

/**
 * Retention cron entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, logs, and exits so Railway re-invokes on schedule. NO purge logic
 * yet — deletion is a later phase and never runs in the per-call path. No keepAlive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'retention-cron' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'retention-cron ran');
}

main().catch((err: unknown) => {
  process.stderr.write(`retention-cron crashed: ${String(err)}\n`);
  process.exit(1);
});
