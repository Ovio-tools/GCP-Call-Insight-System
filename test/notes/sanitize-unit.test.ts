import { describe, expect, it } from 'vitest';
import {
  sanitizeNoteDetail,
  scanFreeTextValue,
  scanNoteQuery,
  serializeNoteDetail,
  serializeNoteList,
  serializeTranscript,
} from '../../src/notes/sanitize.js';
import { makeNoteDetail, makeNoteList } from './_fixture.js';

/**
 * The pure egress guards. The two serializers have deliberately different postures — per-field
 * scrub for the note, whole-body withhold for the transcript — and these tests pin both, plus the
 * reason the query scan does not touch the date bounds.
 */
const DENY = ['Zephyrina Quux'];

describe('transcript serializer fails CLOSED', () => {
  it('passes a clean transcript through unchanged', () => {
    const text = 'Agent: hello\nCaller: my water heater is cold';
    expect(serializeTranscript(text, DENY)).toEqual({ available: true, redacted_text: text });
  });

  it('reports unavailable for an absent row', () => {
    expect(serializeTranscript(undefined, DENY)).toEqual({
      available: false,
      reason: 'unavailable',
    });
  });

  it('withholds the WHOLE body on any residual hit, not just the offending part', () => {
    // This is the difference from the note serializer below. A transcript is one field: a hit
    // anywhere means the redaction we rely on did not hold, so a partially-trusted transcript is
    // not an acceptable answer.
    const mostlyFine = `Agent: hello\nCaller: lots of harmless context here\nCaller: I am Zephyrina Quux`;
    const out = serializeTranscript(mostlyFine, DENY);
    expect(out).toEqual({ available: false, reason: 'withheld' });
    expect(JSON.stringify(out)).not.toContain('harmless context');
  });

  it('withholds on a digit run even with no deny terms configured', () => {
    // The deny list is per-deployment; the structural detectors are not. A phone number must be
    // caught with an EMPTY deny list, or the guard would depend on someone having curated a file.
    expect(serializeTranscript('Caller: reach me on 5551234567', [])).toEqual({
      available: false,
      reason: 'withheld',
    });
  });
});

describe('note detail serializer scrubs per field', () => {
  it('nulls a scalar with a hit and keeps the rest of the note', () => {
    const note = makeNoteDetail((d) => {
      d.access_notes = 'ask for Zephyrina Quux at the gate';
    });
    const { note: out, redactions } = sanitizeNoteDetail(note, DENY);
    expect(out.access_notes).toBeNull();
    // Unlike the transcript, everything else survives — a note is many small fields, and losing
    // all of them because one was dirty would help nobody.
    expect(out.symptom_verbatim).toBe(note.symptom_verbatim);
    expect(out.dispatch_summary).toBe(note.dispatch_summary);
    // Counts only, never the value.
    expect(Object.values(redactions).some((n) => n > 0)).toBe(true);
    expect(JSON.stringify(redactions)).not.toContain('Zephyrina');
  });

  it('drops only the offending element of an array field', () => {
    const note = makeNoteDetail((d) => {
      d.hazards = ['dog in the yard', 'ask for Zephyrina Quux', 'low clearance'];
    });
    expect(sanitizeNoteDetail(note, DENY).note.hazards).toEqual([
      'dog in the yard',
      'low clearance',
    ]);
  });

  it('scrubs the dispatch summary — the field most likely to restate a name', () => {
    const note = makeNoteDetail((d) => {
      d.dispatch_summary = 'Call Zephyrina Quux before arriving.';
    });
    expect(serializeNoteDetail(note, DENY).dispatch_summary).toBeNull();
  });

  it('leaves a clean note untouched', () => {
    // The counterweight: a serializer that nulled everything would satisfy the tests above.
    const note = makeNoteDetail();
    const out = serializeNoteDetail(note, DENY);
    expect(out.access_notes).toBe(note.access_notes);
    expect(out.hazards).toEqual(note.hazards);
    expect(out.dispatch_summary).toBe(note.dispatch_summary);
  });
});

describe('the structural backstop is wired into the note serializers', () => {
  /**
   * `assertNoContentFields` throws on a forbidden KEY NAME — a coding bug, not content. Nothing
   * else in the suite notices if the call is deleted (a mutation run proved exactly that), so these
   * two smuggle a banned key past the type system and assert the throw. Same technique as
   * `test/review/redacted-content-guard.test.ts`.
   *
   * The transcript serializer is deliberately NOT included: it omits this guard on purpose, and
   * that omission is asserted in its own test below.
   */
  it('serializeNoteDetail refuses a smuggled content-shaped key', () => {
    const smuggled = { ...makeNoteDetail(), transcript: 'the whole call' } as ReturnType<
      typeof makeNoteDetail
    >;
    expect(() => serializeNoteDetail(smuggled, DENY)).toThrow(
      /Refusing to log known content field/,
    );
  });

  it('serializeNoteList refuses a smuggled content-shaped key', () => {
    const list = makeNoteList();
    const smuggled = {
      ...list,
      results: [{ ...list.results[0]!, customer_name: 'Zephyrina Quux' }],
    } as unknown as typeof list;
    expect(() => serializeNoteList(smuggled, DENY)).toThrow(/Refusing to log known content field/);
  });

  it('the transcript serializer deliberately does NOT carry that backstop', () => {
    // `redacted_text` is not on the ban list, so the guard would pass here regardless — keeping it
    // would be decoration. The real defense is the residual scan, asserted above. This test pins
    // the decision so a future reader does not "fix" the omission and mistake the pass for proof.
    const withKey = serializeTranscript('Agent: hello\nCaller: hello', DENY);
    expect(withKey).toEqual({
      available: true,
      redacted_text: 'Agent: hello\nCaller: hello',
    });
    expect(Object.keys(withKey)).toContain('redacted_text');
  });
});

describe('query scan', () => {
  it('does not reject a valid date range', () => {
    // A date is structurally a digit run, so scanning the bounds would fail every legitimate
    // search. They are pattern-validated instead, which is what makes them safe.
    expect(scanNoteQuery({ from: '2026-07-12', to: '2026-07-14' }, DENY).safe).toBe(true);
    expect(scanNoteQuery({ from: '2026-07-12T08:30:00Z' }, DENY).safe).toBe(true);
    expect(scanNoteQuery({ service_category: 'water_heater', urgency: 'routine' }, DENY).safe).toBe(
      true,
    );
  });

  it('still detects PII in a free-text value, so the seam is not dead code', () => {
    // `FREE_TEXT_FILTER_KEYS` is empty today. This proves the machinery behind it works, so the
    // first free-text filter added inherits a guard that functions rather than one that rotted.
    expect(scanFreeTextValue('Zephyrina Quux', DENY).safe).toBe(false);
    expect(scanFreeTextValue('call me on 5551234567', []).safe).toBe(false);
    expect(scanFreeTextValue('leaking water heater', DENY).safe).toBe(true);
    // Counts only — the rejected value is never echoed back.
    expect(JSON.stringify(scanFreeTextValue('Zephyrina Quux', DENY))).not.toContain('Zephyrina');
  });
});
