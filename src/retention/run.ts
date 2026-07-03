import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { checkUrlFor, httpPing, pingSuccess, type HeartbeatPinger } from '../heartbeat/index.js';

export interface RetentionDeps {
  config: Config;
  logger: Logger;
  /**
   * The purge step (Task 8.1). Defaults to a no-op placeholder — this task wires ONLY the
   * heartbeat contract, not deletion. Injectable so tests drive success vs failure. If it
   * throws, the run rejects BEFORE the ping, so the missed external check fires the alert.
   */
  purge?: () => Promise<void>;
  /** Fire the dead-man's-switch ping. Defaults to a timed HTTP GET; injectable for tests. */
  pingCheck?: HeartbeatPinger;
}

/**
 * One retention run (Task 7.1 heartbeat contract; purge logic arrives in Task 8.1). Runs the
 * (currently placeholder) purge, then pings the retention cron's OWN external check ONLY on
 * success. Any failure rejects without pinging — the retention monitor going quiet is the
 * alert, independent of the worker and reconciliation checks.
 */
export async function runRetention(deps: RetentionDeps): Promise<void> {
  const { config, logger } = deps;
  const purge = deps.purge ?? ((): Promise<void> => Promise.resolve());

  await purge();
  logger.info({ node_env: config.NODE_ENV }, 'retention-cron ran');

  await pingSuccess({
    component: 'retention-cron',
    url: checkUrlFor(config, 'retention-cron'),
    logger,
    ping: deps.pingCheck ?? httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
  });
}
