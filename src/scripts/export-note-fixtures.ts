import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { exportNoteFeedbackFixtures } from '../evaluation/note-fixtures.js';

/** Default (gitignored) output dir — a real export carries redacted transcripts and is NEVER
 * committed, exactly like `eval:export`. */
const DEFAULT_OUT = 'var/evaluation/note-fixtures';

/** Parse an optional `--out <dir>` override. */
function parseOut(argv: readonly string[]): string {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : DEFAULT_OUT;
}

/**
 * `notes:export` entrypoint (Task 6.3, extended to `note_feedback`). Projects reviewer verdicts on
 * technician notes into golden-fixture files under a gitignored dir (or `--out <dir>`).
 *
 * No model is called: each fixture's model response is rebuilt from the stored `technician_notes`
 * row, so the same rows always produce byte-identical files. Clean-before-write — a stale
 * `note-feedback-*.json` no longer in the current set is removed; nothing else in the dir is
 * touched.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'export-note-fixtures' });
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const out = parseOut(process.argv.slice(2));
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const result = await exportNoteFeedbackFixtures(pool, out, { denyTerms, logger });
    logger.info({ files: result.files.length, ...result.summary }, 'note fixtures exported');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`export-note-fixtures failed: ${String(err)}\n`);
    process.exit(1);
  });
}
