import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { requireCheckUrl } from '../heartbeat/index.js';
import { runRetention } from '../retention/run.js';

/**
 * Retention cron entrypoint. A short-lived Railway cron (daily, UTC): boots, confirms
 * dependencies, runs the retention pass, pings its OWN external check only on success, and
 * exits so Railway re-invokes on schedule. Any failure exits non-zero WITHOUT pinging, so the
 * dead-man's switch fires — independent of the worker and reconciliation checks.
 *
 * Task 7.1 wires the heartbeat contract; the purge logic itself is Task 8.1. Deletion never
 * runs in the per-call path. No keepAlive — the cron must exit.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'retention-cron' });
  // Production/staging must not run an unmonitored purge cron: fail fast, naming the variable.
  requireCheckUrl(config, 'retention-cron');
  await assertDependenciesReady(config, logger);

  await runRetention({ config, logger });
}

main().catch((err: unknown) => {
  process.stderr.write(`retention-cron crashed: ${String(err)}\n`);
  process.exit(1);
});
