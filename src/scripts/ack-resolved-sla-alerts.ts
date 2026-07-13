import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import {
  acknowledgeStalledAlertsForTerminalReviews,
  countTerminalReviewStalledOpen,
} from '../db/repositories/alert-events-repo.js';

/**
 * One-off maintenance backfill: acknowledge every still-open `REVIEW_QUEUE_STALLED` alert whose
 * review item is already TERMINAL (resolved/unresolvable), so a stale "breaching SLA" banner left
 * over from before the resolve-clears-the-alert rule stops lingering on the status page.
 *
 * This only touches alerts whose review item has ALREADY left the active queue — an item still open
 * is genuinely stalled and is left untouched (resolving it now clears its alert via the review path).
 * Read-only under `--dry-run`: reports the count that WOULD be acknowledged and exits without writing.
 *
 * Usage: `node dist/scripts/ack-resolved-sla-alerts.js [--dry-run]`.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'ack-resolved-sla-alerts' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const dryRun = process.argv.slice(2).includes('--dry-run');
  const pool = createAppPool(config.DATABASE_URL);

  try {
    if (dryRun) {
      const eligible = await countTerminalReviewStalledOpen(pool);
      logger.info(
        { dry_run: true, eligible },
        'ack-resolved-sla-alerts (dry run) — nothing written',
      );
      return;
    }
    const acknowledged = await acknowledgeStalledAlertsForTerminalReviews(pool);
    logger.info({ dry_run: false, acknowledged }, 'ack-resolved-sla-alerts complete');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`ack-resolved-sla-alerts crashed: ${String(err)}\n`);
    process.exit(1);
  });
}
