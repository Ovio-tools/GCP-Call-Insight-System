import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { keepAlive } from '../boot/keepalive.js';

/**
 * Webhook-receiver entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, then holds open. NO HTTP listener yet — the real receiver and the
 * shared hardening/auth middleware land in Task 2.1/2.3, so the public domain 502s
 * until then; the deploy itself succeeds because the process stays up.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'webhook-receiver' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'webhook-receiver booted');
  await keepAlive();
}

main().catch((err: unknown) => {
  process.stderr.write(`webhook-receiver crashed: ${String(err)}\n`);
  process.exit(1);
});
