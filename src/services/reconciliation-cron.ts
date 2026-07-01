import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';

/**
 * Reconciliation cron entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, logs, and exits so Railway re-invokes on schedule. NO reconciliation
 * logic yet — that lands in a later phase. A cron must terminate: no keepAlive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'reconciliation-cron' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'reconciliation-cron ran');
}

main().catch((err: unknown) => {
  process.stderr.write(`reconciliation-cron crashed: ${String(err)}\n`);
  process.exit(1);
});
