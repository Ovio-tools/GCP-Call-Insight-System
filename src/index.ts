import { loadConfig } from './config/index.js';
import { createRootLogger } from './logging/logger.js';

/**
 * Entrypoint. Scaffolding only — no business logic yet.
 *
 * Boot sequence: validate configuration (exits naming any missing/invalid var),
 * then build the root logger and emit a single startup line.
 */
function main(): void {
  const config = loadConfig();

  const log = createRootLogger({ level: config.LOG_LEVEL, name: config.SERVICE_NAME });
  log.info({ node_env: config.NODE_ENV, port: config.PORT }, 'service booted');
}

main();
