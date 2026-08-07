import { describe, expect, it } from 'vitest';
import {
  buildNoteQualityReport,
  renderNoteQualityReport,
  type NoteGapRow,
  type NoteQualityReport,
} from '../../src/evaluation/note-report.js';
import { residualScan } from '../../src/redaction/residual-scan.js';
import { at, feedbackRow } from './_note-rows.js';
import type { NoteFeedbackRow } from '../../src/db/schemas/note-feedback.js';

/**
 * The note-quality report. Three things are being pinned: the gap frequency matches a HAND COUNT
 * (this is the report's highest-value output, so an off-by-one here is a business decision made on
 * a wrong number), agreement is broken out per field and per prompt version rather than collapsed
 * into one figure, and the rendered text carries no PII.
 */

/**
 * A seeded corpus, hand-countable on purpose. Six notes; the `not_established` column below is the
 * hand count the assertion re-derives:
 *
 *   access_notes                     n1 n2 n3 n4 n5      -> 5
 *   occupancy                        n1 n2 n3            -> 3
 *   payer_authority.can_approve_work n1 n2 (n2 twice)    -> 2   (a duplicate counts ONCE)
 *   equipment.type                   n4                  -> 1
 *   n6 has no gaps at all.
 */
const NOTES: NoteGapRow[] = [
  {
    prompt_version: 'tech-note-v1',
    not_established: ['access_notes', 'occupancy', 'payer_authority.can_approve_work'],
  },
  {
    prompt_version: 'tech-note-v1',
    not_established: [
      'access_notes',
      'occupancy',
      'payer_authority.can_approve_work',
      'payer_authority.can_approve_work',
    ],
  },
  { prompt_version: 'tech-note-v1', not_established: ['access_notes', 'occupancy'] },
  { prompt_version: 'tech-note-v2', not_established: ['access_notes', 'equipment.type'] },
  { prompt_version: 'tech-note-v2', not_established: ['access_notes'] },
  { prompt_version: 'tech-note-v2', not_established: [] },
];

/**
 * Verdicts across two calls, two prompt versions, two reviewers, including one revision.
 *
 *   v1: occupancy       wrong   (call-1)
 *       occupancy       wrong   (call-2)
 *       equipment.type  correct (call-1)
 *       access_notes    missing (call-1), later REVISED to correct — one standing verdict
 *   v2: occupancy       correct (call-3)
 *       equipment.type  correct (call-3)
 *
 * So v1 has four standing verdicts (two correct) and v2 has two (both correct).
 */
const FEEDBACK: NoteFeedbackRow[] = [
  feedbackRow('occupancy', 'wrong', {
    callId: 'call-1',
    correctedEnumValue: 'tenant',
    createdAt: at(0),
  }),
  feedbackRow('occupancy', 'wrong', {
    callId: 'call-2',
    correctedEnumValue: 'property_manager',
    createdAt: at(1),
  }),
  feedbackRow('equipment.type', 'correct', { callId: 'call-1', createdAt: at(2) }),
  feedbackRow('access_notes', 'missing', { callId: 'call-1', createdAt: at(3) }),
  // The revision: same call, same field, same reviewer, later.
  feedbackRow('access_notes', 'correct', { callId: 'call-1', createdAt: at(90) }),
  feedbackRow('occupancy', 'correct', {
    callId: 'call-3',
    promptVersion: 'tech-note-v2',
    reviewer: 'reviewer-b',
    createdAt: at(120),
  }),
  feedbackRow('equipment.type', 'correct', {
    callId: 'call-3',
    promptVersion: 'tech-note-v2',
    reviewer: 'reviewer-b',
    createdAt: at(121),
  }),
];

const NOW = new Date('2026-08-07T12:34:00.000Z');

function report(): NoteQualityReport {
  return buildNoteQualityReport({ feedback: FEEDBACK, notes: NOTES, now: NOW });
}

describe('not_established frequency — the phone-intake gap list', () => {
  it('matches a hand count on the seeded dataset', () => {
    expect(report().not_established).toEqual([
      { field_path: 'access_notes', notes: 5, share: 5 / 6 },
      { field_path: 'occupancy', notes: 3, share: 3 / 6 },
      { field_path: 'payer_authority.can_approve_work', notes: 2, share: 2 / 6 },
      { field_path: 'equipment.type', notes: 1, share: 1 / 6 },
    ]);
    expect(report().notes_total).toBe(6);
    expect(report().notes_with_gaps).toBe(5);
  });

  it('counts a duplicated entry once per note', () => {
    const single = buildNoteQualityReport({
      feedback: [],
      notes: [{ prompt_version: 'tech-note-v1', not_established: ['occupancy', 'occupancy'] }],
      now: NOW,
    });
    expect(single.not_established).toEqual([{ field_path: 'occupancy', notes: 1, share: 1 }]);
  });

  it('counts an unrecognized entry instead of reporting it', () => {
    const odd = buildNoteQualityReport({
      feedback: [],
      notes: [
        {
          prompt_version: 'tech-note-v1',
          not_established: ['occupancy', 'the customer would not say'],
        },
      ],
      now: NOW,
    });
    expect(odd.unrecognized_not_established).toBe(1);
    expect(odd.not_established.map((g) => g.field_path)).toEqual(['occupancy']);
    expect(renderNoteQualityReport(odd)).not.toContain('the customer would not say');
  });
});

describe('agreement per field path', () => {
  it('breaks the score out per field rather than reporting one number', () => {
    const byField = Object.fromEntries(report().by_field.map((f) => [f.field_path, f]));

    // occupancy: three standing verdicts (call-1 wrong, call-2 wrong, call-3 correct).
    expect(byField.occupancy).toMatchObject({
      verdicts: 3,
      correct: 1,
      wrong: 2,
      missing: 0,
      should_not_be_here: 0,
      corrections: 2,
      agreement: 1 / 3,
    });
    // equipment.type: two verdicts, both correct.
    expect(byField['equipment.type']).toMatchObject({ verdicts: 2, correct: 2, agreement: 1 });
    // access_notes: the revision replaced `missing` with `correct` — ONE verdict, not two.
    expect(byField.access_notes).toMatchObject({
      verdicts: 1,
      correct: 1,
      missing: 0,
      agreement: 1,
    });
  });

  it('lists the worst-performing field first — the point of the breakdown', () => {
    expect(report().by_field[0]!.field_path).toBe('occupancy');
  });

  it('a field nobody judged is absent, not counted as correct', () => {
    const judged = report().by_field.map((f) => f.field_path);
    expect(judged).not.toContain('dispatch_summary');
    expect(judged).not.toContain('scope_signal');
    expect(judged.sort()).toEqual(['access_notes', 'equipment.type', 'occupancy']);
  });
});

describe('agreement by prompt version', () => {
  it('keeps each version`s verdicts attached to the version they were given against', () => {
    expect(report().by_prompt_version).toEqual([
      {
        prompt_version: 'tech-note-v1',
        verdicts: 4,
        correct: 2,
        agreement: 0.5,
        notes_reviewed: 2,
        fields_reviewed: 3,
      },
      {
        prompt_version: 'tech-note-v2',
        verdicts: 2,
        correct: 2,
        agreement: 1,
        notes_reviewed: 1,
        fields_reviewed: 2,
      },
    ]);
  });
});

describe('the rendered report is PII-free', () => {
  /** Positive control: the scanner used here really does hold on a planted number, so the
   * absence assertions below cannot pass vacuously. */
  it('the scanner fires on a planted phone number (control)', () => {
    const scan = residualScan({
      redactedText: 'call back on 555-123-4567 please',
      vaultPlaintexts: [],
      denyTerms: [],
    });
    expect(scan.hits.length).toBeGreaterThan(0);
  });

  it('residualScan over the fully rendered report output returns zero hits', () => {
    const rendered = renderNoteQualityReport(report());
    expect(rendered).toContain('access_notes');
    expect(rendered).toContain('tech-note-v2');

    const scan = residualScan({ redactedText: rendered, vaultPlaintexts: [], denyTerms: [] });
    expect(scan.counts).toEqual({});
    expect(scan.hits).toEqual([]);
  });

  it('stays clean at large counts, where adjacent numbers could form a false digit run', () => {
    // `residualScan` strips every non-alphanumeric before looking for a run of >= 7 digits, so two
    // numeric columns printed side by side would concatenate into a false hit. This is the
    // regression guard on the "a label word between every pair of numbers" rendering invariant.
    const big: NoteQualityReport = {
      generated_at: new Date('2026-12-31T23:59:00.000Z'),
      note_eval_set_version: 1,
      notes_total: 9_876_543,
      notes_with_gaps: 8_765_432,
      calls_reviewed: 7_654_321,
      standing_verdicts: 6_543_210,
      by_field: [
        {
          field_path: 'occupancy',
          verdicts: 1_234_567,
          correct: 2_345_678,
          agreement: 0.123_456,
          wrong: 3_456_789,
          missing: 4_567_890,
          should_not_be_here: 5_678_901,
          corrections: 6_789_012,
        },
      ],
      by_prompt_version: [
        {
          prompt_version: 'tech-note-v1',
          verdicts: 1_234_567,
          correct: 7_654_321,
          agreement: 0.987_654,
          notes_reviewed: 2_345_678,
          fields_reviewed: 3_456_789,
        },
      ],
      not_established: [{ field_path: 'access_notes', notes: 8_765_432, share: 0.887_766 }],
      unrecognized_not_established: 1_234_567,
    };

    const scan = residualScan({
      redactedText: renderNoteQualityReport(big),
      vaultPlaintexts: [],
      denyTerms: [],
    });
    expect(scan.counts).toEqual({});
  });

  it('never renders a call id or a reviewer identity', () => {
    const rendered = renderNoteQualityReport(report());
    for (const secret of ['call-1', 'call-2', 'call-3', 'reviewer-a', 'reviewer-b']) {
      expect(rendered, secret).not.toContain(secret);
    }
  });

  it('renders an empty corpus without inventing numbers', () => {
    const empty = renderNoteQualityReport(
      buildNoteQualityReport({ feedback: [], notes: [], now: NOW }),
    );
    expect(empty).toContain('no gaps recorded across the stored notes');
    expect(empty).toContain('no verdicts recorded yet');
    expect(
      residualScan({ redactedText: empty, vaultPlaintexts: [], denyTerms: [] }).counts,
    ).toEqual({});
  });
});
