import { describe, expect, it } from 'vitest';
import { createNerDetector, titleCase } from '../../src/redaction/ner-detector.js';
import type { Detection } from '../../src/redaction/types.js';
import { hasNerModel, makeNerConfig } from './_ner.js';

function surface(text: string, d: Detection): string {
  return text.slice(d.start, d.end);
}

const LOAD_TIMEOUT = 120_000;

describe('titleCase', () => {
  it('capitalizes word starts and preserves length', () => {
    const s = "yeah it's kevin oconnor, ok?";
    const t = titleCase(s);
    expect(t).toBe("Yeah It's Kevin Oconnor, Ok?");
    expect(t.length).toBe(s.length);
  });
});

describe.skipIf(!hasNerModel)('NER detector (model-gated)', () => {
  const detector = createNerDetector(makeNerConfig());

  it(
    'detects PER/LOC/ORG with exact char offsets and mapped types',
    async () => {
      const text = 'Hi, this is John Smith calling from Sacramento about Acme Plumbing Supply.';
      const { detections } = await detector.detect(text);
      const byType = (t: string): string[] =>
        detections.filter((d) => d.entityType === t).map((d) => surface(text, d));

      expect(byType('name')).toContain('John Smith');
      expect(byType('location')).toContain('Sacramento');
      expect(byType('organization').some((s) => s.includes('Acme Plumbing'))).toBe(true);
      for (const d of detections) {
        expect(d.detector).toBe('ner');
        expect(d.confidence).toBeGreaterThan(0);
      }
    },
    LOAD_TIMEOUT,
  );

  it(
    'catches all-lowercase names via the title-cased second pass',
    async () => {
      const text = 'yeah so uh my landlord kevin oconnor said to call you guys';
      const { detections } = await detector.detect(text);
      const names = detections
        .filter((d) => d.entityType === 'name')
        .map((d) => surface(text, d).toLowerCase());
      expect(names.some((n) => n.includes('kevin'))).toBe(true);
    },
    LOAD_TIMEOUT,
  );

  it(
    'sees an entity that straddles a chunk boundary via the overlap',
    async () => {
      const filler = 'please call me back about the water heater soon ok thanks ';
      // Place the name so it straddles the first chunk's end (chunkChars=120).
      const prefix = filler.slice(0, 110);
      const text = `${prefix}Maria Gonzalez said the unit is leaking again`;
      const det = createNerDetector(makeNerConfig({ chunkChars: 120, chunkOverlapChars: 60 }));
      const { detections } = await det.detect(text);
      const names = detections.filter((d) => d.entityType === 'name');
      expect(names.some((d) => surface(text, d).includes('Maria Gonzalez'))).toBe(true);
    },
    LOAD_TIMEOUT,
  );

  it(
    'still redacts sub-minScore candidates and raises ner_low_confidence',
    async () => {
      const det = createNerDetector(makeNerConfig({ minScore: 1 }));
      const text = 'Hi, this is John Smith calling about the heater.';
      const { detections, riskSignals } = await det.detect(text);
      // The span is present (never dropped) ...
      expect(
        detections.some((d) => d.entityType === 'name' && surface(text, d).includes('John Smith')),
      ).toBe(true);
      // ... and the low-confidence signal fires.
      expect(riskSignals.some((s) => s.reason === 'ner_low_confidence')).toBe(true);
    },
    LOAD_TIMEOUT,
  );

  it(
    'raises transcript_chunking_truncated when a chunk saturates the model window',
    async () => {
      // A single huge chunk of 600 spoken digits tokenizes past bert's 512 cap.
      const det = createNerDetector(makeNerConfig({ chunkChars: 50_000 }));
      const text = Array.from({ length: 600 }, (_, i) => String(i % 10)).join(' ');
      const { riskSignals } = await det.detect(text);
      expect(riskSignals.some((s) => s.reason === 'transcript_chunking_truncated')).toBe(true);
    },
    LOAD_TIMEOUT,
  );

  it(
    'returns no detections or signals for entity-free text',
    async () => {
      const { detections, riskSignals } = await detector.detect(
        'please just fix the water heater soon, the pilot light is out again',
      );
      expect(detections).toHaveLength(0);
      expect(riskSignals).toHaveLength(0);
    },
    LOAD_TIMEOUT,
  );
});
