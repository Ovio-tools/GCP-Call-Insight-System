import { describe, expect, it } from 'vitest';
import {
  REQUIRED_FOR_DISPATCH,
  assertDispatchSummaryLength,
  computeNotEstablished,
  scanNoteForResidual,
  type TechnicianNoteRecord,
} from '../../src/technician-notes/index.js';
import { NOTE_FIELD_PATHS } from '../../src/db/enums.js';
import { DISPATCH_SUMMARY_MAX_LENGTH } from '../../src/db/schemas/technician-notes.js';
import { expectedRecord, fixtureByName, validFixtures } from './fixtures.js';

const NO_DENY_TERMS: readonly string[] = [];

function recordOf(name: string): TechnicianNoteRecord {
  return structuredClone(expectedRecord(fixtureByName(name)));
}

describe('REQUIRED_FOR_DISPATCH', () => {
  it('is the fixed list a dispatcher needs settled', () => {
    expect([...REQUIRED_FOR_DISPATCH]).toEqual([
      'scope_signal',
      'equipment.type',
      'location_on_property',
      'water_status.supply_shut_off',
      'occupancy',
      'payer_authority.can_approve_work',
      'access_notes',
    ]);
  });

  it('names only real, addressable note field paths', () => {
    for (const path of REQUIRED_FOR_DISPATCH) {
      expect(NOTE_FIELD_PATHS, `${path} is not a note field path`).toContain(path);
    }
  });
});

describe('computeNotEstablished', () => {
  it('produces the expected gap list for every fixture that declares one', () => {
    for (const f of validFixtures) {
      if (f.expectedNotEstablished === undefined) continue;
      expect(computeNotEstablished(expectedRecord(f)), f.name).toEqual(f.expectedNotEstablished);
    }
  });

  it('is produced in CODE: nulling a required path updates the array with no model involved', () => {
    const record = recordOf('golden-drain-clog');
    const before = computeNotEstablished(record);
    expect(before).not.toContain('equipment.type');

    // Mutate a VALIDATED model output — the only input the gate gets. No client, no fixture
    // reload, no second response: the array must move purely from the record's contents.
    record.equipment.type = null;
    const after = computeNotEstablished(record);

    expect(after).toContain('equipment.type');
    expect(after.length).toBe(before.length + 1);
  });

  it('treats the two NOT NULL enums as unestablished only when they are literally "unknown"', () => {
    const record = recordOf('golden-drain-clog');
    expect(computeNotEstablished(record)).not.toContain('scope_signal');
    expect(computeNotEstablished(record)).not.toContain('occupancy');

    record.scope_signal = 'unknown';
    record.occupancy = 'unknown';
    const after = computeNotEstablished(record);
    expect(after).toContain('scope_signal');
    expect(after).toContain('occupancy');
  });

  it('treats an empty string as unestablished, not as a value', () => {
    const record = recordOf('golden-drain-clog');
    record.access_notes = '';
    expect(computeNotEstablished(record)).toContain('access_notes');
  });

  it('returns every required path for a call where nothing was established', () => {
    const record = recordOf('golden-nothing-established');
    expect(computeNotEstablished(record)).toEqual([...REQUIRED_FOR_DISPATCH]);
  });

  it('returns an empty array when every required path was settled', () => {
    expect(computeNotEstablished(recordOf('golden-access-code-given'))).toEqual([]);
  });

  it('preserves REQUIRED_FOR_DISPATCH order, so the note reads the same way every time', () => {
    const record = recordOf('golden-nothing-established');
    const gaps = computeNotEstablished(record);
    const order = REQUIRED_FOR_DISPATCH.filter((p) => gaps.includes(p));
    expect(gaps).toEqual([...order]);
  });
});

describe('scanNoteForResidual', () => {
  it('leaves every clean golden fixture untouched', () => {
    for (const f of validFixtures) {
      if (f.expectedResidual !== undefined) continue;
      const record = expectedRecord(f);
      const { record: out, residual } = scanNoteForResidual(record, NO_DENY_TERMS);
      expect(residual.hit, `${f.name} tripped the residual scan unexpectedly`).toBe(false);
      expect(out).toEqual(record);
    }
  });

  it('nulls a narrative field holding planted PII and records the category, counts only', () => {
    const f = fixtureByName('adversarial-planted-pii-symptom');
    const record = expectedRecord(f);
    const { record: out, residual } = scanNoteForResidual(record, NO_DENY_TERMS);

    expect(residual.hit).toBe(true);
    expect(out.symptom_verbatim).toBeNull();
    expect(residual.fieldsNulled).toEqual(['symptom_verbatim']);
    expect(Object.keys(residual.counts)).toEqual(f.expectedResidual?.categories);
    expect(residual.counts.digit_run).toBeGreaterThan(0);

    // The record is counts and constant ids only — the offending text appears nowhere in it.
    expect(JSON.stringify(residual)).not.toContain('5551234567');
  });

  it('does not mutate the input record', () => {
    const record = expectedRecord(fixtureByName('adversarial-planted-pii-symptom'));
    const before = structuredClone(record);
    scanNoteForResidual(record, NO_DENY_TERMS);
    expect(record).toEqual(before);
  });

  it('leaves fields the scan did not flag alone', () => {
    const { record: out } = scanNoteForResidual(
      expectedRecord(fixtureByName('adversarial-planted-pii-symptom')),
      NO_DENY_TERMS,
    );
    expect(out.access_notes).toBe('knock loudly, doorbell is broken');
    expect(out.dispatch_summary).not.toBeNull();
  });

  it('drops individual array elements rather than the whole array', () => {
    const record = recordOf('golden-grinder-pump');
    record.hazards = ['sewage odour in the basement', 'reach me on 5551234567'];
    const { record: out, residual } = scanNoteForResidual(record, NO_DENY_TERMS);

    expect(out.hazards).toEqual(['sewage odour in the basement']);
    expect(residual.elementsDropped.hazards).toBe(1);
    expect(residual.fieldsNulled).toEqual([]);
    expect(residual.hit).toBe(true);
  });

  it('scans urgency_context elements too', () => {
    const record = recordOf('golden-after-hours-emergency');
    record.urgency_context = [...record.urgency_context, 'callback at 5551234567'];
    const { record: out, residual } = scanNoteForResidual(record, NO_DENY_TERMS);
    expect(out.urgency_context).toEqual([
      'water is actively running',
      'caller cannot locate the shutoff',
    ]);
    expect(residual.elementsDropped.urgency_context).toBe(1);
  });

  it('scans dispatch_summary, prior_attempts_detail and access_notes as well', () => {
    for (const field of ['dispatch_summary', 'prior_attempts_detail', 'access_notes'] as const) {
      const record = recordOf('golden-drain-clog');
      record[field] = 'call the office on 5551234567';
      const { record: out, residual } = scanNoteForResidual(record, NO_DENY_TERMS);
      expect(out[field], field).toBeNull();
      expect(residual.fieldsNulled, field).toContain(field);
    }
  });

  it('honours the deny list passed in as a parameter', () => {
    const record = recordOf('golden-drain-clog');
    const { residual } = scanNoteForResidual(record, ['dishwasher']);
    expect(residual.hit).toBe(true);
    expect(residual.counts.deny_list_term).toBeGreaterThan(0);
  });

  it('feeds the gap list: a required field nulled for PII shows up as not established', () => {
    const record = recordOf('golden-drain-clog');
    expect(computeNotEstablished(record)).not.toContain('access_notes');

    record.access_notes = 'gate code, then call 5551234567';
    const { record: scanned } = scanNoteForResidual(record, NO_DENY_TERMS);
    expect(scanned.access_notes).toBeNull();
    // This ordering is the point: residual scan runs BEFORE the gap list in the generator.
    expect(computeNotEstablished(scanned)).toContain('access_notes');
  });
});

describe('assertDispatchSummaryLength', () => {
  it('passes for every fixture', () => {
    for (const f of validFixtures) {
      expect(() => {
        assertDispatchSummaryLength(expectedRecord(f));
      }, f.name).not.toThrow();
    }
  });

  it('passes for a null summary and for one at exactly the cap', () => {
    const record = recordOf('golden-drain-clog');
    record.dispatch_summary = null;
    expect(() => {
      assertDispatchSummaryLength(record);
    }).not.toThrow();
    record.dispatch_summary = 'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH);
    expect(() => {
      assertDispatchSummaryLength(record);
    }).not.toThrow();
  });

  it('throws for a summary that somehow bypassed validation', () => {
    const record = recordOf('golden-drain-clog');
    record.dispatch_summary = 'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH + 1);
    expect(() => {
      assertDispatchSummaryLength(record);
    }).toThrow(/dispatch_summary exceeds 800/);
  });

  it('does not put the summary text into the thrown message', () => {
    const record = recordOf('golden-drain-clog');
    record.dispatch_summary = 'LEAKED'.repeat(200);
    expect(() => {
      assertDispatchSummaryLength(record);
    }).toThrow(/^(?!.*LEAKED).*$/s);
  });
});
