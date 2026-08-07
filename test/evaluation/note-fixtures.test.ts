import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFixtureDir } from '../../src/evaluation/export-fixtures.js';
import { buildNoteFixture, noteFixtureFilename } from '../../src/evaluation/note-fixtures.js';
import { parseTechnicianNote } from '../../src/technician-notes/parse.js';
import { at, feedbackRow, noteRow } from './_note-rows.js';

/**
 * Note fixtures are a pure projection of stored rows — no model call, no clock, no randomness.
 * That is what makes them reproducible: the same rows must always produce the same bytes, so a
 * regenerated fixture set is a no-op diff and a real diff means the DATA changed.
 */

const DENY: readonly string[] = [];

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'note-fixtures-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One call, one note, a handful of verdicts — the ordinary case. */
function seed(): {
  note: ReturnType<typeof noteRow>;
  feedback: ReturnType<typeof feedbackRow>[];
} {
  return {
    note: noteRow({ callId: 'call-77', notEstablished: ['access_notes'] }),
    feedback: [
      feedbackRow('equipment.type', 'correct', { callId: 'call-77', createdAt: at(0) }),
      feedbackRow('occupancy', 'wrong', {
        callId: 'call-77',
        correctedEnumValue: 'tenant',
        createdAt: at(5),
      }),
      feedbackRow('access_notes', 'missing', { callId: 'call-77', createdAt: at(6) }),
    ],
  };
}

function buildOne(redactedText: string | undefined): {
  file: string;
  body: unknown;
} {
  const { note, feedback } = seed();
  const result = buildNoteFixture({ note, feedback, redactedText, denyTerms: DENY });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture build failed');
  return { file: result.file, body: result.body };
}

describe('buildNoteFixture — reproducible from stored rows, with no live model call', () => {
  it('a fixture generated twice from the same rows is byte-identical', () => {
    const first = tempDir();
    const second = tempDir();
    const a = buildOne('a fully redacted transcript');
    const b = buildOne('a fully redacted transcript');

    writeFixtureDir(first, [a], 'note-feedback-');
    writeFixtureDir(second, [b], 'note-feedback-');

    const namesA = readdirSync(first).sort();
    expect(namesA).toEqual(readdirSync(second).sort());
    expect(namesA).toContain('MANIFEST.json');
    for (const name of namesA) {
      // Byte comparison, not a parsed-object comparison: key order and whitespace are part of the
      // guarantee, because a reordered rewrite is a spurious diff in every future review.
      expect(readFileSync(join(first, name)), name).toEqual(readFileSync(join(second, name)));
    }
  });

  it('the model response is rebuilt from the stored note and parses back to it', () => {
    const { body } = buildOne('a fully redacted transcript');
    const fixture = body as { modelResponse: { text: string; stopReason: string } };
    const parsed = parseTechnicianNote(fixture.modelResponse);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.occupancy).toBe('owner');
    expect(parsed.record.equipment.type).toBe('tank water heater');
  });

  it('the expected output holds ONLY the judged fields', () => {
    const { body } = buildOne('a fully redacted transcript');
    const fixture = body as { expected: { assertions: { field_path: string }[] } };
    // Canonical note order (NOTE_FIELD_PATHS), not the order the verdicts were given in.
    expect(fixture.expected.assertions.map((a) => a.field_path)).toEqual([
      'equipment.type',
      'access_notes',
      'occupancy',
    ]);
  });

  it('a revised verdict produces a fixture reflecting only the latest', () => {
    const note = noteRow({ callId: 'call-88' });
    const base = feedbackRow('occupancy', 'wrong', {
      callId: 'call-88',
      correctedEnumValue: 'tenant',
      createdAt: at(0),
    });
    const revision = feedbackRow('occupancy', 'correct', { callId: 'call-88', createdAt: at(45) });

    const before = buildNoteFixture({ note, feedback: [base], redactedText: 'x', denyTerms: DENY });
    const after = buildNoteFixture({
      note,
      feedback: [base, revision],
      redactedText: 'x',
      denyTerms: DENY,
    });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    expect(before.body.expected.assertions).toEqual([
      {
        field_path: 'occupancy',
        verdict: 'wrong',
        corrected_enum_value: 'tenant',
        contested: false,
      },
    ]);
    // The superseded verdict leaves no trace in the fixture — not as a second assertion, and not
    // as the corrected value it carried.
    expect(after.body.expected.assertions).toEqual([
      { field_path: 'occupancy', verdict: 'correct', corrected_enum_value: null, contested: false },
    ]);
    expect(JSON.stringify(after.body)).not.toContain('tenant');
  });

  it('verdicts against a superseded prompt version are not exported as this note`s fixture', () => {
    const note = noteRow({ callId: 'call-99', promptVersion: 'tech-note-v2' });
    const stale = feedbackRow('occupancy', 'wrong', {
      callId: 'call-99',
      promptVersion: 'tech-note-v1',
      correctedEnumValue: 'tenant',
    });
    const result = buildNoteFixture({
      note,
      feedback: [stale],
      redactedText: 'x',
      denyTerms: DENY,
    });
    expect(result).toEqual({ ok: false, reason: 'no_verdicts' });
  });

  it('records where the transcript came from, and omits it when purged', () => {
    const withText = buildOne('a fully redacted transcript');
    expect(withText.body).toMatchObject({ redactedTranscriptSource: 'clean_transcripts' });

    const withoutText = buildOne(undefined);
    expect(withoutText.body).toMatchObject({
      redactedTranscript: null,
      redactedTranscriptSource: 'absent',
    });
    // The assertions survive a purged transcript — both stores behind them are never purged.
    const fixture = withoutText.body as { expected: { assertions: unknown[] } };
    expect(fixture.expected.assertions).toHaveLength(3);
  });

  it('withholds a transcript that trips the residual gate, and still exports the note', () => {
    const { note, feedback } = seed();
    const result = buildNoteFixture({
      note,
      feedback,
      redactedText: 'call me back on 5551234567 tomorrow',
      denyTerms: DENY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.redactedTranscriptSource).toBe('withheld_pii');
    expect(result.body.redactedTranscript).toBeNull();
    expect(JSON.stringify(result.body)).not.toContain('5551234567');
  });

  it('rejects the whole fixture, content-free, when the NOTE itself trips the residual gate', () => {
    const { feedback } = seed();
    const note = noteRow({
      callId: 'call-77',
      symptomVerbatim: 'she said to call 5551234567 before arriving',
    });
    const result = buildNoteFixture({ note, feedback, redactedText: 'x', denyTerms: DENY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pii');
    expect(result.categories).toEqual(['digit_run']);
    expect(JSON.stringify(result)).not.toContain('5551234567');
  });

  it('filenames are deterministic and filesystem-safe', () => {
    expect(noteFixtureFilename('call-77', 'tech-note-v1')).toBe(
      'note-feedback-1-call-77-tech-note-v1.json',
    );
    expect(noteFixtureFilename('a/b c', 'v/1')).toBe('note-feedback-1-a_b_c-v_1.json');
  });
});

describe('writeFixtureDir — clean-before-write', () => {
  it('removes a stale generated file and leaves everything else alone', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'note-feedback-1-gone-tech-note-v1.json'), '{}\n');
    writeFileSync(join(dir, 'curated-note.json'), '{}\n');

    const entry = buildOne('a fully redacted transcript');
    writeFixtureDir(dir, [entry], 'note-feedback-');

    const names = readdirSync(dir).sort();
    expect(names).not.toContain('note-feedback-1-gone-tech-note-v1.json');
    expect(names).toContain('curated-note.json');
    expect(names).toContain(entry.file);
  });
});
