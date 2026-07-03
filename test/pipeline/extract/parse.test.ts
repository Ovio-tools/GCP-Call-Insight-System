import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractionRecordSchema,
  parseExtraction,
  type ExtractionRecord,
  type ParseFailureKind,
} from '../../../src/pipeline/extract/parse.js';
import { EXTRACT_OUTPUT_FORMAT } from '../../../src/anthropic/client.js';
import { CALL_INTENT, SERVICE_CATEGORIES, URGENCY, SENTIMENTS } from '../../../src/db/enums.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));

interface ExtractFixture {
  name: string;
  redactedTranscript: string;
  modelResponse: { text: string | null; stopReason: string | null; usagePresent?: boolean };
  expected: { record: Partial<ExtractionRecord> } | { failure: ParseFailureKind };
}

function loadFixtures(): ExtractFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as ExtractFixture);
}

const fixtures = loadFixtures();

/** A schema-valid inner record, reused for direct precedence tests. */
const VALID_RECORD: ExtractionRecord = {
  call_intent: 'general',
  service_category: 'other',
  problem_statement: 'ok',
  symptoms: [],
  customer_language: [],
  competitor_mentions: [],
  concerns: [],
  location_in_home: null,
  access_or_scheduling_notes: null,
  prior_attempts: null,
  acquisition_source: null,
  urgency: 'routine',
  sentiment: 'neutral',
};
const VALID_JSON = JSON.stringify(VALID_RECORD);

describe('extract fixture corpus', () => {
  it('loads a non-empty corpus', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('has at least one golden success record', () => {
    expect(fixtures.some((f) => 'record' in f.expected)).toBe(true);
  });
});

describe('parseExtraction (fixture-driven)', () => {
  for (const fx of fixtures) {
    it(`${fx.name}`, () => {
      const result = parseExtraction({
        text: fx.modelResponse.text,
        stopReason: fx.modelResponse.stopReason,
      });

      if ('record' in fx.expected) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          for (const [key, value] of Object.entries(fx.expected.record)) {
            expect(result.record[key as keyof ExtractionRecord]).toEqual(value);
          }
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure).toBe(fx.expected.failure);
        }
      }
    });
  }
});

describe('parseExtraction (precedence / direct cases)', () => {
  it('refusal wins even when text is schema-valid JSON', () => {
    expect(parseExtraction({ text: VALID_JSON, stopReason: 'refusal' })).toEqual({
      ok: false,
      failure: 'refusal',
    });
  });

  it('max_tokens → truncated even when text is schema-valid JSON', () => {
    expect(parseExtraction({ text: VALID_JSON, stopReason: 'max_tokens' })).toEqual({
      ok: false,
      failure: 'truncated',
    });
  });

  it('null stop reason → unexpected_stop_reason even when text is schema-valid', () => {
    expect(parseExtraction({ text: VALID_JSON, stopReason: null })).toEqual({
      ok: false,
      failure: 'unexpected_stop_reason',
    });
  });

  it('end_turn is a normal stop reason and passes through', () => {
    const result = parseExtraction({ text: VALID_JSON, stopReason: 'end_turn' });
    expect(result.ok).toBe(true);
  });

  it('stop_sequence is a normal stop reason and passes through', () => {
    const result = parseExtraction({ text: VALID_JSON, stopReason: 'stop_sequence' });
    expect(result.ok).toBe(true);
  });
});

describe('extractionRecordSchema', () => {
  it('accepts a valid record', () => {
    expect(extractionRecordSchema.safeParse(VALID_RECORD).success).toBe(true);
  });

  it('rejects extras (strict) — a smuggled confidence key', () => {
    expect(extractionRecordSchema.safeParse({ ...VALID_RECORD, confidence: 0.9 }).success).toBe(
      false,
    );
  });

  it('rejects an empty problem_statement and an over-long one', () => {
    expect(
      extractionRecordSchema.safeParse({ ...VALID_RECORD, problem_statement: '' }).success,
    ).toBe(false);
    expect(
      extractionRecordSchema.safeParse({ ...VALID_RECORD, problem_statement: 'x'.repeat(501) })
        .success,
    ).toBe(false);
  });

  it('rejects a too-long array (max 20 items)', () => {
    expect(
      extractionRecordSchema.safeParse({
        ...VALID_RECORD,
        symptoms: Array.from({ length: 21 }, () => 'x'),
      }).success,
    ).toBe(false);
  });
});

describe('wire ↔ zod cross-check', () => {
  const wireProps = EXTRACT_OUTPUT_FORMAT.schema.properties;
  const zodShape = extractionRecordSchema.shape;

  it('enum arrays match the zod enum options', () => {
    expect(wireProps.call_intent.enum).toEqual([...CALL_INTENT]);
    expect(wireProps.service_category.enum).toEqual([...SERVICE_CATEGORIES]);
    expect(wireProps.urgency.enum).toEqual([...URGENCY]);
    expect(wireProps.sentiment.enum).toEqual([...SENTIMENTS]);
  });

  it('required covers all 13 properties', () => {
    const required = EXTRACT_OUTPUT_FORMAT.schema.required;
    expect(required.length).toBe(13);
    expect(new Set(required)).toEqual(new Set(Object.keys(zodShape)));
  });

  it('additionalProperties is false', () => {
    expect(EXTRACT_OUTPUT_FORMAT.schema.additionalProperties).toBe(false);
  });

  it('property key set equals the zod schema key set', () => {
    expect(new Set(Object.keys(wireProps))).toEqual(new Set(Object.keys(zodShape)));
    expect(Object.keys(zodShape).length).toBe(13);
  });
});
