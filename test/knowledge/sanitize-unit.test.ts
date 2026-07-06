import { describe, expect, it } from 'vitest';
import { sanitizeKnowledgeRecord, serializeKnowledgeExport } from '../../src/knowledge/sanitize.js';
import { buildKnowledgeCsv } from '../../src/knowledge/csv.js';
import type { KnowledgeRecord } from '../../src/knowledge/dto.js';

/**
 * The per-field value-level guard (Findings 2, 3 & 5). `sanitizeKnowledgeRecord` scrubs a scalar to
 * null and drops the offending phrase from an array, returning `.redactions` as categories/counts
 * ONLY — never the value. The pure `buildKnowledgeCsv` then faithfully escapes the already-sanitized
 * records (it does not remove PII itself).
 */
const DENY = ['verboten'];

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

describe('sanitizeKnowledgeRecord', () => {
  it('scrubs a scalar field with PII to null and reports counts only', () => {
    const { record: out, redactions } = sanitizeKnowledgeRecord(
      record({ problem_statement: 'the code is verboten' }),
      DENY,
    );
    expect(out.problem_statement).toBeNull();
    expect(Object.keys(redactions).length).toBeGreaterThan(0);
    expect(JSON.stringify(redactions)).not.toContain('verboten');
  });

  it('scrubs the acquisition_source scalar too (not only customer_language)', () => {
    const { record: out } = sanitizeKnowledgeRecord(
      record({ acquisition_source: 'referred by verboten' }),
      DENY,
    );
    expect(out.acquisition_source).toBeNull();
  });

  it('drops only the offending phrase from an array, keeping clean phrases', () => {
    const { record: out } = sanitizeKnowledgeRecord(
      record({ customer_language: ['it is dead', 'the word verboten', 'please help'] }),
      DENY,
    );
    expect(out.customer_language).toEqual(['it is dead', 'please help']);
  });

  it('leaves a clean record untouched with empty redactions', () => {
    const { record: out, redactions } = sanitizeKnowledgeRecord(record(), DENY);
    expect(out).toEqual(record());
    expect(redactions).toEqual({});
  });

  it('never places a value into redactions (categories/counts only)', () => {
    const { redactions } = sanitizeKnowledgeRecord(
      record({ concerns: ['verboten worry'], location_in_home: 'call 5551234567' }),
      DENY,
    );
    for (const [k, v] of Object.entries(redactions)) {
      expect(typeof k).toBe('string');
      expect(typeof v).toBe('number');
    }
    expect(JSON.stringify(redactions)).not.toContain('verboten');
    expect(JSON.stringify(redactions)).not.toContain('5551234567');
  });
});

describe('serializeKnowledgeExport + CSV faithfulness', () => {
  it('removes PII in the serialized export, and the CSV builder preserves the sanitized input', () => {
    const dto = {
      filters: {},
      total: 1,
      truncated: false,
      results: [
        record({
          problem_statement: 'verboten leak',
          customer_language: ['verboten', 'ok phrase'],
        }),
      ],
    };
    const serialized = serializeKnowledgeExport(dto, DENY);
    expect(serialized.results[0]!.problem_statement).toBeNull();
    expect(serialized.results[0]!.customer_language).toEqual(['ok phrase']);

    const csv = buildKnowledgeCsv(serialized.results);
    expect(csv).not.toContain('verboten');
    expect(csv).toContain('ok phrase');
  });
});
