import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { listNoteFeedbackForEvaluation } from '../db/repositories/note-feedback-repo.js';
import { getTechnicianNote } from '../db/repositories/technician-notes-repo.js';
import type { NoteFeedbackRow } from '../db/schemas/note-feedback.js';
import type { TechnicianNoteRow } from '../db/schemas/technician-notes.js';
import { scanNoteForResidual } from '../technician-notes/gates.js';
import { writeFixtureDir } from './export-fixtures.js';
import {
  buildNoteAssertions,
  compareStrings,
  noteRecordFromRow,
  type NoteFieldAssertion,
} from './note-label.js';
import { validateRedactedInputSafe } from './pii-gate.js';
import { NOTE_EVAL_SET_VERSION } from './version.js';

/**
 * Project reviewer verdicts on technician notes into golden-fixture files (Task 6.3, extended to
 * `note_feedback`). The note-side counterpart of `export-fixtures.ts`, and it shares that module's
 * clean-before-write writer.
 *
 * NO LIVE MODEL CALL. A fixture's `modelResponse` is REBUILT from the stored `technician_notes`
 * row (`noteRecordFromRow`), so the same rows always produce the same bytes and an export is a
 * pure projection of the database rather than a fresh generation. Nothing here is timestamped, so
 * re-running over unchanged rows rewrites byte-identical files.
 *
 * VERSION SCOPING IS THE HARD PART. A note is regenerated IN PLACE (PK `call_id`), so once a call
 * is re-noted under a new prompt version the note those verdicts were given against is gone. A
 * fixture is therefore built only when the stored note's `prompt_version` equals the feedback's
 * `note_prompt_version`; otherwise it is a counted `version_drift` skip. The report still counts
 * those verdicts (grouped by the version they were given against) — an accuracy comparison across
 * prompt versions is the whole point — but a FIXTURE needs the note text, and that text is gone.
 *
 * PRIVACY. Both inputs are de-identified stores. As defence in depth the note's free-text surfaces
 * are re-run through the SAME `scanNoteForResidual` the generator applies (a hit rejects the
 * fixture content-free), and the redacted transcript through the residual gate (a hit WITHHOLDS
 * the text and the fixture is still written from the note alone). Raw transcripts and the vault
 * are unreachable from here — those live in DB-B.
 */

/** The generated-file prefix; clean-before-write only ever removes files matching it. */
const NOTE_FIXTURE_PREFIX = 'note-feedback-';

/** Where a fixture's `redactedTranscript` came from, so a consumer never guesses at a `null`. */
export type TranscriptSource = 'clean_transcripts' | 'absent' | 'withheld_pii';

/** The exported fixture body. Key order here IS the on-disk key order — keep it stable. */
export interface NoteFeedbackFixture {
  name: string;
  notePromptVersion: string;
  noteSchemaVersion: number;
  modelId: string;
  redactedTranscript: string | null;
  redactedTranscriptSource: TranscriptSource;
  modelResponse: { text: string; stopReason: string; usagePresent: boolean };
  expected: { assertions: NoteFieldAssertion[] };
}

export interface BuildNoteFixtureInput {
  note: TechnicianNoteRow;
  /** Feedback rows for THIS call — any prompt version; the builder filters to the note's own. */
  feedback: readonly NoteFeedbackRow[];
  /** The call's redacted transcript, or `undefined` when purged/absent. */
  redactedText: string | undefined;
  denyTerms: readonly string[];
}

export type BuildNoteFixtureResult =
  | { ok: true; file: string; body: NoteFeedbackFixture; transcript: TranscriptSource }
  | { ok: false; reason: 'no_verdicts' | 'schema' | 'pii'; categories?: string[] };

/** Filename-safe form of a stored identifier — everything outside the set becomes `_`. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Deterministic, rebuild-stable filename for one call's verdicts at one prompt version. */
export function noteFixtureFilename(callId: string, promptVersion: string): string {
  const version = String(NOTE_EVAL_SET_VERSION);
  return `${NOTE_FIXTURE_PREFIX}${version}-${safeSegment(callId)}-${safeSegment(promptVersion)}.json`;
}

/**
 * Build one fixture from stored rows. PURE — no DB, no fs, no clock, no model.
 *
 * Order of gates mirrors the note generator: residual scan FIRST (PII precedence), then the schema
 * gate, then assembly. A note whose free text trips the scan is rejected content-free rather than
 * exported with the offending text.
 */
export function buildNoteFixture(input: BuildNoteFixtureInput): BuildNoteFixtureResult {
  const { note, feedback, redactedText, denyTerms } = input;

  const forVersion = feedback.filter(
    (f) => f.call_id === note.call_id && f.note_prompt_version === note.prompt_version,
  );
  if (forVersion.length === 0) return { ok: false, reason: 'no_verdicts' };

  const built = noteRecordFromRow(note);
  if (!built.ok) return { ok: false, reason: 'schema' };

  const { residual } = scanNoteForResidual(built.record, denyTerms);
  if (residual.hit) {
    // Categories only — never the offending text, never the field values.
    return {
      ok: false,
      reason: 'pii',
      categories: Object.keys(residual.counts).sort(compareStrings),
    };
  }

  let transcript: TranscriptSource = 'absent';
  let redactedTranscript: string | null = null;
  if (redactedText !== undefined) {
    const gate = validateRedactedInputSafe(redactedText, denyTerms);
    transcript = gate.safe ? 'clean_transcripts' : 'withheld_pii';
    redactedTranscript = gate.safe ? redactedText : null;
  }

  const file = noteFixtureFilename(note.call_id, note.prompt_version);
  return {
    ok: true,
    file,
    transcript,
    body: {
      name: file.replace(/\.json$/, ''),
      notePromptVersion: note.prompt_version,
      noteSchemaVersion: note.schema_version,
      modelId: note.model_id,
      redactedTranscript,
      redactedTranscriptSource: transcript,
      modelResponse: {
        text: JSON.stringify(built.record),
        stopReason: 'end_turn',
        usagePresent: true,
      },
      expected: { assertions: buildNoteAssertions(forVersion) },
    },
  };
}

/** Outcome tally for one export run — counts only, never call content. */
export interface NoteFixtureSummary {
  written: number;
  /** Written WITHOUT a transcript (purged/absent). The assertions are still exportable. */
  missing_clean: number;
  /** Written with the transcript withheld — the residual gate tripped on it. */
  transcript_withheld: number;
  /** The stored note has been regenerated under a newer prompt version; the reviewed note is gone. */
  version_drift: number;
  /** No stored note at all for a call that has verdicts. */
  missing_note: number;
  rejected_pii: number;
  rejected_schema: number;
  failed: number;
}

export interface ExportNoteFixturesDeps {
  denyTerms: readonly string[];
  logger: Logger;
}

/**
 * Export every exportable call's fixture into `dir`. Clean-before-write: a `note-feedback-*.json`
 * no longer in the current set is removed, so a rebuilt database never leaves orphan files.
 *
 * Per-call failures are counted and do NOT abort the remaining calls, mirroring
 * `syncLabeledExamples`; only the top-level feedback read is allowed to propagate.
 */
export async function exportNoteFeedbackFixtures(
  pool: Pool,
  dir: string,
  deps: ExportNoteFixturesDeps,
): Promise<{ files: string[]; summary: NoteFixtureSummary }> {
  const { denyTerms, logger } = deps;
  const summary: NoteFixtureSummary = {
    written: 0,
    missing_clean: 0,
    transcript_withheld: 0,
    version_drift: 0,
    missing_note: 0,
    rejected_pii: 0,
    rejected_schema: 0,
    failed: 0,
  };

  const feedback = await listNoteFeedbackForEvaluation(pool);
  const byCall = new Map<string, NoteFeedbackRow[]>();
  for (const row of feedback) {
    const held = byCall.get(row.call_id);
    if (held) held.push(row);
    else byCall.set(row.call_id, [row]);
  }

  const entries: { file: string; body: unknown }[] = [];
  for (const callId of [...byCall.keys()].sort(compareStrings)) {
    const rows = byCall.get(callId)!;
    try {
      const note = await getTechnicianNote(pool, callId);
      if (note === undefined) {
        summary.missing_note += 1;
        continue;
      }
      if (!rows.some((r) => r.note_prompt_version === note.prompt_version)) {
        summary.version_drift += 1;
        continue;
      }

      const clean = await getCleanTranscript(pool, callId);
      const result = buildNoteFixture({
        note,
        feedback: rows,
        redactedText: clean?.redacted_text,
        denyTerms,
      });
      if (!result.ok) {
        if (result.reason === 'pii') {
          summary.rejected_pii += 1;
          logger.warn(
            { component: 'note-evaluation', call_id: callId, categories: result.categories },
            'note fixture held by the residual-PII gate — not exported',
          );
        } else if (result.reason === 'schema') {
          summary.rejected_schema += 1;
        }
        continue;
      }

      entries.push({ file: result.file, body: result.body });
      summary.written += 1;
      if (result.transcript === 'absent') summary.missing_clean += 1;
      if (result.transcript === 'withheld_pii') summary.transcript_withheld += 1;
    } catch (err) {
      // Log the error CLASS only — a message can carry a DB string. Counted, never fatal.
      summary.failed += 1;
      logger.error(
        {
          component: 'note-evaluation',
          call_id: callId,
          error: err instanceof Error ? err.name : typeof err,
        },
        'note fixture export failed for a call',
      );
    }
  }

  const files = writeFixtureDir(dir, entries, NOTE_FIXTURE_PREFIX);
  logger.info({ component: 'note-evaluation', ...summary }, 'note fixture export complete');
  return { files, summary };
}
