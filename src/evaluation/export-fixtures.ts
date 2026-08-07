import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { listAcceptedExamples } from '../db/repositories/labeled-examples-repo.js';
import type {
  ExpectedClassifyOutput,
  ExpectedExtractOutput,
  LabeledExampleRow,
} from '../db/schemas/labeled-examples.js';
import { buildExtractRecord } from './labeled-example.js';

/**
 * Project the accepted labeled corpus into golden-fixture files the parse harness can load (Task
 * 6.3). The DB table is the source of truth; this is a CLEAN-BEFORE-WRITE projection: any stale
 * `reviewed-*.json` no longer in the current accepted set is removed before writing, so a rebuilt
 * DB never leaves orphan files (finding 8). Deterministic filenames make the output stable across
 * rebuilds (finding 7). Curated fixtures live in the PARENT dir and are never touched — only the
 * `reviewed/` dirs passed here are managed. A `MANIFEST.json` lists the generated files.
 *
 * Reads only the CURRENT `EVAL_SET_VERSION` + `PII_GATE_VERSION` set (the repo default). Real
 * exports default to a gitignored dir; only synthetic samples are committed.
 */

export interface ExportDirs {
  classifyDir: string;
  extractDir: string;
}

export interface ExportResult {
  classify: string[];
  extract: string[];
}

/** Deterministic, rebuild-stable filename for one accepted label. */
function fixtureFilename(row: LabeledExampleRow): string {
  return `reviewed-${row.eval_set_version}-${row.task_type}-${row.operator_action_id}.json`;
}

/** The existing classify fixture shape — a reviewer-labeled bucket. */
function classifyFixture(row: LabeledExampleRow): unknown {
  const expected = row.expected_output as ExpectedClassifyOutput;
  return {
    name: fixtureFilename(row).replace(/\.json$/, ''),
    redactedTranscript: row.redacted_input,
    modelResponse: {
      text: JSON.stringify({ bucket: expected.bucket, reason: 'reviewer-labeled' }),
      stopReason: 'end_turn',
      usagePresent: true,
    },
    expected: { bucket: expected.bucket },
  };
}

/** The existing extract fixture shape — full 13-field record text, expected pins the 4 enums. */
function extractFixture(row: LabeledExampleRow): unknown {
  const enums = row.expected_output as ExpectedExtractOutput;
  return {
    name: fixtureFilename(row).replace(/\.json$/, ''),
    redactedTranscript: row.redacted_input,
    modelResponse: {
      text: JSON.stringify(buildExtractRecord(enums)),
      stopReason: 'end_turn',
      usagePresent: true,
    },
    expected: { record: enums },
  };
}

/** The generated-file prefix this module manages. Clean-before-write only ever touches these. */
const REVIEWED_PREFIX = 'reviewed-';

/**
 * Write one dir's fixtures: mkdir, remove orphan `<prefix>*.json`, write files + MANIFEST.
 *
 * Shared with the technician-note fixture export (`note-fixtures.ts`), which passes its own
 * prefix — one clean-before-write implementation, so the two projections cannot drift on the
 * rule that matters: a generated file no longer in the current set is REMOVED, and nothing
 * outside the prefix is ever touched.
 *
 * Deterministic by construction: no timestamps, sorted MANIFEST, stable `JSON.stringify` shape.
 * Re-running over unchanged rows rewrites byte-identical files.
 */
export function writeFixtureDir(
  dir: string,
  entries: { file: string; body: unknown }[],
  prefix: string = REVIEWED_PREFIX,
): string[] {
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(entries.map((e) => e.file));
  // Clean-before-write: drop any generated file not in the current accepted set. Only touches the
  // prefixed projection, never curated fixtures (which live in the parent dir).
  for (const existing of readdirSync(dir)) {
    if (existing.startsWith(prefix) && existing.endsWith('.json') && !wanted.has(existing)) {
      rmSync(join(dir, existing));
    }
  }
  const written: string[] = [];
  for (const entry of entries) {
    writeFileSync(join(dir, entry.file), `${JSON.stringify(entry.body, null, 2)}\n`);
    written.push(entry.file);
  }
  written.sort();
  writeFileSync(join(dir, 'MANIFEST.json'), `${JSON.stringify({ files: written }, null, 2)}\n`);
  return written;
}

export async function exportReviewedFixtures(pool: Pool, dirs: ExportDirs): Promise<ExportResult> {
  const rows = await listAcceptedExamples(pool);
  const classify: { file: string; body: unknown }[] = [];
  const extract: { file: string; body: unknown }[] = [];
  for (const row of rows) {
    if (row.task_type === 'classify') {
      classify.push({ file: fixtureFilename(row), body: classifyFixture(row) });
    } else {
      extract.push({ file: fixtureFilename(row), body: extractFixture(row) });
    }
  }
  return {
    classify: writeFixtureDir(dirs.classifyDir, classify),
    extract: writeFixtureDir(dirs.extractDir, extract),
  };
}
