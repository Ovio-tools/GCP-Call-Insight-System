import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classificationSchema,
  parseClassification,
  type ParseFailureKind,
} from '../../../src/pipeline/classify/parse.js';
import { CLASSIFY_BUCKETS } from '../../../src/anthropic/client.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/classify/', import.meta.url));

interface ClassifyFixture {
  name: string;
  redactedTranscript: string;
  modelResponse: { text: string | null; stopReason: string | null; usagePresent?: boolean };
  expected: { bucket: string } | { failure: ParseFailureKind; usageMissing?: true };
}

function loadFixtures(): ClassifyFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as ClassifyFixture);
}

const fixtures = loadFixtures();

describe('classify fixture corpus', () => {
  it('loads a non-empty corpus', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('covers every bucket at least once', () => {
    const buckets = new Set(
      fixtures
        .filter((f) => 'bucket' in f.expected)
        .map((f) => (f.expected as { bucket: string }).bucket),
    );
    for (const b of CLASSIFY_BUCKETS) {
      expect(buckets).toContain(b);
    }
  });
});

describe('parseClassification (fixture-driven)', () => {
  for (const fx of fixtures) {
    it(`${fx.name}`, () => {
      const result = parseClassification({
        text: fx.modelResponse.text,
        stopReason: fx.modelResponse.stopReason,
      });

      if ('bucket' in fx.expected) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.bucket).toBe(fx.expected.bucket);
          // The success result exposes ONLY bucket — `reason` is structurally dropped.
          expect(result).not.toHaveProperty('reason');
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

describe('parseClassification (precedence / direct cases)', () => {
  it('refusal wins even when text is schema-valid JSON', () => {
    expect(
      parseClassification({
        text: '{"bucket":"customer","reason":"ok"}',
        stopReason: 'refusal',
      }),
    ).toEqual({ ok: false, failure: 'refusal' });
  });

  it('max_tokens → truncated even when text is schema-valid JSON', () => {
    expect(
      parseClassification({
        text: '{"bucket":"customer","reason":"ok"}',
        stopReason: 'max_tokens',
      }),
    ).toEqual({ ok: false, failure: 'truncated' });
  });

  it('null stop reason → unexpected_stop_reason even when text is schema-valid', () => {
    expect(
      parseClassification({
        text: '{"bucket":"customer","reason":"ok"}',
        stopReason: null,
      }),
    ).toEqual({ ok: false, failure: 'unexpected_stop_reason' });
  });

  it('end_turn is a normal stop reason and passes through', () => {
    expect(
      parseClassification({
        text: '{"bucket":"spam","reason":"robocall"}',
        stopReason: 'end_turn',
      }),
    ).toEqual({ ok: true, bucket: 'spam' });
  });

  it('stop_sequence is a normal stop reason and passes through', () => {
    expect(
      parseClassification({
        text: '{"bucket":"held","reason":"unclear"}',
        stopReason: 'stop_sequence',
      }),
    ).toEqual({ ok: true, bucket: 'held' });
  });
});

describe('classificationSchema', () => {
  it('accepts a valid object and rejects extras (strict)', () => {
    expect(classificationSchema.safeParse({ bucket: 'customer', reason: 'ok' }).success).toBe(true);
    expect(
      classificationSchema.safeParse({ bucket: 'customer', reason: 'ok', extra: 1 }).success,
    ).toBe(false);
  });

  it('rejects an empty reason and an over-long reason', () => {
    expect(classificationSchema.safeParse({ bucket: 'customer', reason: '' }).success).toBe(false);
    expect(
      classificationSchema.safeParse({ bucket: 'customer', reason: 'x'.repeat(301) }).success,
    ).toBe(false);
  });
});
