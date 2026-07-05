import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { syncLabeledExamples } from '../evaluation/sync.js';

/**
 * `eval:sync` entrypoint (Task 6.3). A short-lived one-shot: boot, mine resolved review decisions
 * into the labeled corpus, log the counts-only summary, release resources, exit. Derivation-only +
 * idempotent — safe to run repeatedly. In normal operation the reconciliation cron runs this every
 * 15 min; this manual runner is for local backfill / on-demand capture.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'sync-labeled-examples' });
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const summary = await syncLabeledExamples(pool, { denyTerms, logger });
    logger.info({ ...summary }, 'label sync finished');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`sync-labeled-examples failed: ${String(err)}\n`);
    process.exit(1);
  });
}
