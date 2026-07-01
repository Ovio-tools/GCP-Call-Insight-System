import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { keepAlive } from '../boot/keepalive.js';

/**
 * Worker entrypoint (Task 0.3: infrastructure only). Boots, confirms dependencies,
 * then holds open. NO queue consumer yet — BullMQ wiring lands in Task 2.1. No
 * public domain.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'worker' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'worker booted');
  await keepAlive();
}

main().catch((err: unknown) => {
  process.stderr.write(`worker crashed: ${String(err)}\n`);
  process.exit(1);
});
