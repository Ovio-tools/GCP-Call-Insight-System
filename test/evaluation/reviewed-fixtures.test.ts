import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtures } from '../support/fixture-loader.js';
import { parseClassification } from '../../src/pipeline/classify/parse.js';
import { parseExtraction } from '../../src/pipeline/extract/parse.js';

/**
 * The committed synthetic reviewed-format fixtures load through the existing golden-fixture harness
 * (Task 6.3). Proves the reviewed export format is loadable in CI WITHOUT committing any real
 * redacted customer transcript (only synthetic samples live in the repo).
 */
const CLASSIFY_DIR = fileURLToPath(new URL('../fixtures/classify/', import.meta.url));
const EXTRACT_DIR = fileURLToPath(new URL('../fixtures/extract/', import.meta.url));

interface ClassifyFixture {
  name: string;
  redactedTranscript: string;
  modelResponse: { text: string | null; stopReason: string | null };
  expected: { bucket: string } | { failure: string };
}
interface ExtractFixture {
  name: string;
  redactedTranscript: string;
  modelResponse: { text: string | null; stopReason: string | null };
  expected: { record: Record<string, unknown> } | { failure: string };
}

describe('committed synthetic reviewed fixtures', () => {
  it('has at least one reviewed classify + extract sample present', () => {
    expect(existsSync(join(CLASSIFY_DIR, 'reviewed'))).toBe(true);
    expect(existsSync(join(EXTRACT_DIR, 'reviewed'))).toBe(true);
  });

  it('every reviewed classify sample parses to its expected bucket', () => {
    const reviewed = loadFixtures<ClassifyFixture>(CLASSIFY_DIR).filter((f) =>
      f.name.startsWith('reviewed-'),
    );
    expect(reviewed.length).toBeGreaterThan(0);
    for (const fx of reviewed) {
      const result = parseClassification({
        text: fx.modelResponse.text,
        stopReason: fx.modelResponse.stopReason,
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'bucket' in fx.expected) expect(result.bucket).toBe(fx.expected.bucket);
    }
  });

  it('every reviewed extract sample parses to a schema-valid record pinning the 4 enums', () => {
    const reviewed = loadFixtures<ExtractFixture>(EXTRACT_DIR).filter((f) =>
      f.name.startsWith('reviewed-'),
    );
    expect(reviewed.length).toBeGreaterThan(0);
    for (const fx of reviewed) {
      const result = parseExtraction({
        text: fx.modelResponse.text,
        stopReason: fx.modelResponse.stopReason,
      });
      expect(result.ok).toBe(true);
      if (result.ok && 'record' in fx.expected) {
        for (const [key, value] of Object.entries(fx.expected.record)) {
          expect(result.record[key as keyof typeof result.record]).toEqual(value);
        }
      }
    }
  });
});
