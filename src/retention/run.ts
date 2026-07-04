import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { checkUrlFor, httpPing, pingSuccess, type HeartbeatPinger } from '../heartbeat/index.js';
import type { PurgeReport } from './purge.js';

export interface RetentionDeps {
  config: Config;
  logger: Logger;
  /**
   * The purge step (Task 8.1). Defaults to a no-op that returns an empty report. Injectable so
   * tests drive success / skip / failure. If it throws, the run rejects BEFORE the ping, so the
   * missed external check fires the alert.
   */
  purge?: () => Promise<PurgeReport>;
  /** Fire the dead-man's-switch ping. Defaults to a timed HTTP GET; injectable for tests. */
  pingCheck?: HeartbeatPinger;
}

const EMPTY_REPORT: PurgeReport = { dryRun: false, actions: [], groupCounts: [] };

/**
 * One retention run (Task 7.1 heartbeat contract + Task 8.1 purge). Runs the purge, logs its
 * report, then pings the retention cron's OWN external check ONLY on a run that did work. Any
 * failure rejects without pinging — the retention monitor going quiet is the alert. A SKIPPED
 * run (another run holds the advisory lock) also withholds the ping: pinging success would mask
 * the active run's own missed ping were it to later hang or fail.
 */
export async function runRetention(deps: RetentionDeps): Promise<void> {
  const { config, logger } = deps;
  const purge = deps.purge ?? ((): Promise<PurgeReport> => Promise.resolve(EMPTY_REPORT));

  const report = await purge();
  logger.info(
    { node_env: config.NODE_ENV, dry_run: report.dryRun, skipped: report.skipped ?? false },
    'retention-cron ran',
  );

  if (report.skipped) {
    logger.info(
      { node_env: config.NODE_ENV },
      'retention run skipped (lock held) — withholding ping',
    );
    return;
  }

  await pingSuccess({
    component: 'retention-cron',
    url: checkUrlFor(config, 'retention-cron'),
    logger,
    ping: deps.pingCheck ?? httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
  });
}
