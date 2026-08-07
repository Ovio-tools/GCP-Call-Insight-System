import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { listNoteFeedbackForEvaluation } from '../db/repositories/note-feedback-repo.js';
import { listNoteGapRows } from '../db/repositories/technician-notes-repo.js';
import { buildNoteQualityReport, renderNoteQualityReport } from '../evaluation/note-report.js';

/**
 * `notes:report` entrypoint (Task 6.3, extended to `note_feedback`). A short-lived one-shot: boot,
 * read the reviewer verdicts and the stored gap lists, print the report, exit. READ-ONLY — it
 * writes no table and calls no model, so it is safe to run at any time and as often as wanted.
 *
 * What it answers, in order of business value:
 *   1. which questions the phone intake keeps failing to ask (`not_established` frequency);
 *   2. which note fields the model gets wrong (agreement per field path);
 *   3. whether a prompt change helped (agreement by note prompt version).
 *
 * Output is PII-free by construction — field paths, verdict names, prompt versions, and counts
 * only. See the invariant comment in `src/evaluation/note-report.ts`.
 *
 * Usage:
 *   note-quality-report [--json] [--out <file>]
 *
 *   --json        emit the report object instead of the rendered text (for a dashboard/diff).
 *   --out <file>  write to a file instead of stdout.
 */
export interface ReportArgs {
  json: boolean;
  out?: string;
}

export function parseArgs(argv: readonly string[]): ReportArgs {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (out === undefined || out.startsWith('--'))) {
    throw new Error('--out requires a file path');
  }
  return out === undefined
    ? { json: argv.includes('--json') }
    : { json: argv.includes('--json'), out };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'note-quality-report' });
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const args = parseArgs(process.argv.slice(2));
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const [feedback, notes] = await Promise.all([
      listNoteFeedbackForEvaluation(pool),
      listNoteGapRows(pool),
    ]);
    const report = buildNoteQualityReport({ feedback, notes, now: new Date() });
    const body = args.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderNoteQualityReport(report);

    if (args.out === undefined) process.stdout.write(body);
    else writeFileSync(args.out, body);

    // Counts only — the report body itself never reaches a log line.
    logger.info(
      {
        component: 'note-evaluation',
        notes_total: report.notes_total,
        calls_reviewed: report.calls_reviewed,
        standing_verdicts: report.standing_verdicts,
        fields_with_verdicts: report.by_field.length,
        prompt_versions: report.by_prompt_version.length,
      },
      'note quality report generated',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`note-quality-report failed: ${String(err)}\n`);
    process.exit(1);
  });
}
