import { describe, expect, it } from 'vitest';
import { NOTE_FIELD_PATHS } from '../../src/db/enums.js';
import {
  buildNoteAssertions,
  expectedNoteOutputSchema,
  noteRecordFromRow,
} from '../../src/evaluation/note-label.js';
import { at, feedbackRow, noteRow } from './_note-rows.js';

/**
 * The note label is a set of FIELD-LEVEL ASSERTIONS, not a full expected record (Task 6.3 extended
 * to `note_feedback`). These suites pin the three properties that make it honest: silence is not
 * agreement, a revision supersedes, and a disagreement is surfaced rather than averaged away.
 */
describe('buildNoteAssertions — field-level assertions from append-only verdicts', () => {
  it('a field with no verdict is ABSENT from the expected output, never defaulted to correct', () => {
    const assertions = buildNoteAssertions([
      feedbackRow('occupancy', 'wrong', { correctedEnumValue: 'tenant' }),
      feedbackRow('equipment.type', 'correct'),
    ]);

    const judged = assertions.map((a) => a.field_path);
    expect(judged).toEqual(['equipment.type', 'occupancy']);

    // Every OTHER field of the note is simply not in the expected output — not present with a
    // 'correct' verdict, not present with a null, not present at all.
    const unjudged = NOTE_FIELD_PATHS.filter((p) => !judged.includes(p));
    expect(unjudged.length).toBeGreaterThan(30);
    for (const path of unjudged) {
      expect(assertions.find((a) => a.field_path === path)).toBeUndefined();
    }
    expect(expectedNoteOutputSchema.safeParse({ assertions }).success).toBe(true);
  });

  it('a revised verdict supersedes the original — only the latest counts', () => {
    const assertions = buildNoteAssertions([
      feedbackRow('scope_signal', 'wrong', {
        correctedEnumValue: 'whole_property',
        createdAt: at(0),
      }),
      feedbackRow('scope_signal', 'correct', { createdAt: at(30) }),
    ]);

    expect(assertions).toEqual([
      {
        field_path: 'scope_signal',
        verdict: 'correct',
        corrected_enum_value: null,
        contested: false,
      },
    ]);
  });

  it('resolves a same-instant revision by id, matching the SQL tie-break', () => {
    const sameInstant = at(5);
    const assertions = buildNoteAssertions([
      feedbackRow('occupancy', 'correct', {
        createdAt: sameInstant,
        id: '00000000-0000-4000-8000-0000000000a1',
      }),
      feedbackRow('occupancy', 'wrong', {
        createdAt: sameInstant,
        correctedEnumValue: 'tenant',
        id: '00000000-0000-4000-8000-0000000000a2',
      }),
    ]);

    expect(assertions[0]).toMatchObject({ verdict: 'wrong', corrected_enum_value: 'tenant' });
  });

  it('input order does not change the result', () => {
    const rows = [
      feedbackRow('scope_signal', 'wrong', { createdAt: at(0) }),
      feedbackRow('scope_signal', 'correct', { createdAt: at(30) }),
      feedbackRow('access_notes', 'missing', { createdAt: at(10) }),
    ];
    expect(buildNoteAssertions([...rows].reverse())).toEqual(buildNoteAssertions(rows));
  });

  it('two reviewers who disagree mark the field contested, latest wins', () => {
    const assertions = buildNoteAssertions([
      feedbackRow('occupancy', 'correct', { reviewer: 'reviewer-a', createdAt: at(0) }),
      feedbackRow('occupancy', 'wrong', {
        reviewer: 'reviewer-b',
        correctedEnumValue: 'property_manager',
        createdAt: at(10),
      }),
    ]);

    expect(assertions).toEqual([
      {
        field_path: 'occupancy',
        verdict: 'wrong',
        corrected_enum_value: 'property_manager',
        contested: true,
      },
    ]);
  });

  it('two reviewers who agree are not contested, and count once', () => {
    const assertions = buildNoteAssertions([
      feedbackRow('occupancy', 'correct', { reviewer: 'reviewer-a', createdAt: at(0) }),
      feedbackRow('occupancy', 'correct', { reviewer: 'reviewer-b', createdAt: at(10) }),
    ]);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]!.contested).toBe(false);
  });

  it('assertions come back in canonical note order regardless of arrival order', () => {
    const assertions = buildNoteAssertions([
      feedbackRow('dispatch_summary', 'wrong'),
      feedbackRow('scope_signal', 'correct'),
      feedbackRow('equipment.brand', 'missing'),
    ]);
    expect(assertions.map((a) => a.field_path)).toEqual([
      'scope_signal',
      'equipment.brand',
      'dispatch_summary',
    ]);
  });

  it('the expected-output schema rejects a corrected value outside the controlled list', () => {
    const parsed = expectedNoteOutputSchema.safeParse({
      assertions: [
        {
          field_path: 'occupancy',
          verdict: 'wrong',
          corrected_enum_value: 'landlord',
          contested: false,
        },
      ],
    });
    expect(parsed.success).toBe(false);
    // The rejected value is never echoed back (it could be anything a raw-SQL writer stored).
    expect(JSON.stringify(parsed.error?.issues ?? [])).not.toContain('landlord');
  });

  it('the expected-output schema rejects an empty assertion set — silence is not a label', () => {
    expect(expectedNoteOutputSchema.safeParse({ assertions: [] }).success).toBe(false);
  });
});

describe('noteRecordFromRow — the stored note projected back to the wire record', () => {
  it('drops the stored-only columns and keeps the note itself', () => {
    const built = noteRecordFromRow(noteRow({ notEstablished: ['access_notes'] }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const keys = Object.keys(built.record);
    // `not_established` is computed in code by the gates, never returned by the model — a fixture
    // that carried one would teach the wrong contract.
    expect(keys).not.toContain('not_established');
    expect(keys).not.toContain('call_id');
    expect(keys).not.toContain('prompt_version');
    expect(built.record.scope_signal).toBe('single_fixture');
    expect(built.record.equipment.type).toBe('tank water heater');
  });

  it('serializes byte-identically whatever key order the jsonb groups arrive in', () => {
    const canonical = noteRow();
    const shuffled = {
      ...canonical,
      // Postgres hands jsonb back in its own key order; the projection must not inherit it.
      equipment: Object.fromEntries(
        Object.entries(canonical.equipment).reverse(),
      ) as typeof canonical.equipment,
    };

    const a = noteRecordFromRow(canonical);
    const b = noteRecordFromRow(shuffled);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.record)).toBe(JSON.stringify(b.record));
  });

  it('refuses a stored row that no longer validates against the note schema', () => {
    const broken = { ...noteRow(), scope_signal: 'not_a_scope' as never };
    expect(noteRecordFromRow(broken).ok).toBe(false);
  });
});
