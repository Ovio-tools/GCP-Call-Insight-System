import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { exportReviewedFixtures } from '../evaluation/export-fixtures.js';

/** Default (gitignored) output root — real reviewed exports are NEVER committed. */
const DEFAULT_OUT = 'var/evaluation/reviewed-fixtures';

/** Parse an optional `--out <dir>` root override (defaults to the gitignored dir). */
function parseOut(argv: readonly string[]): string {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : DEFAULT_OUT;
}

/**
 * `eval:export` entrypoint (Task 6.3). Projects the accepted labeled corpus into golden-fixture
 * files under a gitignored dir (or `--out <dir>`). Clean-before-write: stale `reviewed-*.json` no
 * longer in the accepted set are removed; curated fixtures are never touched. The DB is the source
 * of truth — this is a rebuildable projection.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'export-reviewed-fixtures' });
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const out = parseOut(process.argv.slice(2));
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const result = await exportReviewedFixtures(pool, {
      classifyDir: join(out, 'classify'),
      extractDir: join(out, 'extract'),
    });
    logger.info(
      { classify: result.classify.length, extract: result.extract.length },
      'reviewed fixtures exported',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`export-reviewed-fixtures failed: ${String(err)}\n`);
    process.exit(1);
  });
}
