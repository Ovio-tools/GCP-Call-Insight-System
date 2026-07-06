import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_CSV_COLUMNS, buildKnowledgeCsv, toCsvCell } from '../../src/knowledge/csv.js';
import type { KnowledgeRecord } from '../../src/knowledge/dto.js';

/**
 * `buildKnowledgeCsv` is PURE and preserves its input faithfully — it escapes, it does not remove
 * PII (Finding 5; sanitization is the serializer's job). These tests cover escaping only.
 */

/** A minimal but complete record; tests override the field under probe. */
function record(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    call_id: 'call-1',
    created_at: '2026-07-05T12:00:00.000Z',
    call_intent: 'new_booking',
    service_category: 'water_heater',
    urgency: 'routine',
    problem_statement: 'no hot water',
    symptoms: ['no hot water'],
    customer_language: ['it is dead'],
    concerns: ['cost'],
    competitor_mentions: [],
    acquisition_source: 'google',
    location_in_home: 'basement',
    access_or_scheduling_notes: null,
    prior_attempts: null,
    ...overrides,
  };
}

describe('toCsvCell', () => {
  it('renders null / undefined as an empty string', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('joins arrays with "; "', () => {
    expect(toCsvCell(['a', 'b', 'c'])).toBe('a; b; c');
    expect(toCsvCell([])).toBe('');
  });

  it('quotes and doubles internal quotes when the cell contains a comma, quote, CR, or newline', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(toCsvCell('line1\rline2')).toBe('"line1\rline2"');
  });

  it('leaves a plain cell untouched', () => {
    expect(toCsvCell('basement')).toBe('basement');
  });

  it('neutralizes formula-injection cells by prefixing a single quote', () => {
    expect(toCsvCell('=1+1')).toBe("'=1+1");
    expect(toCsvCell('+1')).toBe("'+1");
    expect(toCsvCell('-1')).toBe("'-1");
    expect(toCsvCell('@x')).toBe("'@x");
    // optional leading spaces before a formula char
    expect(toCsvCell('  =1+1')).toBe("'  =1+1");
  });

  it('always neutralizes a leading tab / CR / LF (Finding 4)', () => {
    expect(toCsvCell('\t=1+1')).toBe("'\t=1+1");
    expect(toCsvCell('\r=1+1')).toBe('"\'\r=1+1"'); // guard prefixes, then CR forces quoting
    expect(toCsvCell('\tplain')).toBe("'\tplain");
    expect(toCsvCell('\rplain')).toBe('"\'\rplain"');
  });

  it('applies the formula guard to a cell an array joins into', () => {
    expect(toCsvCell(['=danger', 'x'])).toBe("'=danger; x");
  });
});

describe('buildKnowledgeCsv', () => {
  it('emits a stable header row equal to the allowlisted columns', () => {
    const csv = buildKnowledgeCsv([]);
    expect(csv).toBe(KNOWLEDGE_CSV_COLUMNS.join(','));
  });

  it('emits exactly header + one row per record — no note rows', () => {
    const csv = buildKnowledgeCsv([record({ call_id: 'a' }), record({ call_id: 'b' })]);
    const lines = csv.split('\n');
    // header + 2 records; embedded newlines would be inside quotes, none here.
    expect(lines[0]).toBe(KNOWLEDGE_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('a,')).toBe(true);
    expect(lines[2]!.startsWith('b,')).toBe(true);
  });

  it('escapes a record faithfully, in column order', () => {
    const csv = buildKnowledgeCsv([
      record({
        call_id: 'call-1',
        problem_statement: 'a,b',
        symptoms: ['x', 'y'],
        acquisition_source: null,
      }),
    ]);
    const dataRow = csv.split('\n')[1]!;
    // call_id, created_at, call_intent, service_category, urgency, problem_statement, symptoms, ...
    expect(dataRow).toContain('"a,b"');
    expect(dataRow).toContain('x; y');
  });
});
