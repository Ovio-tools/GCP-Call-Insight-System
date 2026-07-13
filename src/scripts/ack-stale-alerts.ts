import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import {
  acknowledgeAlertsForCompletedCalls,
  acknowledgeStalledAlertsForTerminalReviews,
  countAlertsForCompletedCallsOpen,
  countTerminalReviewStalledOpen,
} from '../db/repositories/alert-events-repo.js';

/**
 * One-off maintenance backfill: acknowledge stale status-page alerts left over from before the
 * auto-acknowledge rules existed, so a misleading "degraded" banner stops lingering. Two classes,
 * both provably resolved:
 *   - `REVIEW_QUEUE_STALLED` alerts whose review item is already TERMINAL (resolved/unresolvable);
 *   - ANY alert whose call has since reached `completed`.
 * An alert whose review is still open, or whose call has not completed, is left untouched — it may
 * be genuinely active. Read-only under `--dry-run`: reports the counts and writes nothing.
 *
 * Going forward these are handled automatically (resolving a review / completing a call
 * acknowledges the alert in the same transaction); this script only clears the pre-existing backlog.
 *
 * Usage: `node dist/scripts/ack-stale-alerts.js [--dry-run]`.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'ack-stale-alerts' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const dryRun = process.argv.slice(2).includes('--dry-run');
  const pool = createAppPool(config.DATABASE_URL);

  try {
    if (dryRun) {
      const [terminalReview, completedCall] = await Promise.all([
        countTerminalReviewStalledOpen(pool),
        countAlertsForCompletedCallsOpen(pool),
      ]);
      logger.info(
        { dry_run: true, terminal_review_stalled: terminalReview, completed_call: completedCall },
        'ack-stale-alerts (dry run) — nothing written',
      );
      return;
    }
    // Terminal-review first, then completed-call. They may overlap (a stalled alert for a call that
    // also completed) — the second UPDATE only sees still-open rows, so overlap is never double-run.
    const terminalReview = await acknowledgeStalledAlertsForTerminalReviews(pool);
    const completedCall = await acknowledgeAlertsForCompletedCalls(pool);
    logger.info(
      { dry_run: false, terminal_review_stalled: terminalReview, completed_call: completedCall },
      'ack-stale-alerts complete',
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`ack-stale-alerts crashed: ${String(err)}\n`);
    process.exit(1);
  });
}
