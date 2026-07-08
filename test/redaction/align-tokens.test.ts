import { describe, expect, it } from 'vitest';
import { alignTokens } from '../../src/redaction/ner-detector.js';

/**
 * Direct unit tests for the wordpiece → char-offset aligner (no model needed):
 * synthetic TokenHit arrays exercise the merge, whole-word snapping, and
 * per-span confidence aggregation that the model-gated suites can only reach
 * end-to-end.
 */

interface Hit {
  entity: string;
  score: number;
  word: string;
}

function hit(entity: string, word: string, score = 0.9): Hit {
  return { entity, score, word };
}

function surface(text: string, span: { start: number; end: number }, offset = 0): string {
  return text.slice(span.start - offset, span.end - offset);
}

describe('alignTokens', () => {
  it('aligns a clean B-PER/I-PER run to one span with exact offsets', () => {
    const text = 'call John Smith now';
    const tokens = [
      hit('O', 'call'),
      hit('B-PER', 'John', 0.99),
      hit('I-PER', 'Smith', 0.97),
      hit('O', 'now'),
    ];
    const { spans, alignmentFailed } = alignTokens(text, tokens, 0);
    expect(alignmentFailed).toBe(false);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.entityType).toBe('name');
    expect(surface(text, spans[0] ?? { start: 0, end: 0 })).toBe('John Smith');
  });

  it('merges contiguous same-type pieces regardless of inconsistent B-/I- markers', () => {
    const text = 'ask for Villanueva please';
    const tokens = [
      hit('O', 'ask'),
      hit('O', 'for'),
      hit('B-PER', 'Villa', 0.9),
      hit('B-PER', '##nue', 0.8),
      hit('I-PER', '##va', 0.7),
      hit('O', 'please'),
    ];
    const { spans } = alignTokens(text, tokens, 0);
    expect(spans).toHaveLength(1);
    expect(surface(text, spans[0] ?? { start: 0, end: 0 })).toBe('Villanueva');
  });

  it('aggregates per-span confidence as the MEAN of the wordpiece scores', () => {
    const text = 'ask for Villanueva please';
    const tokens = [
      hit('O', 'ask'),
      hit('O', 'for'),
      hit('B-PER', 'Villa', 0.9),
      hit('I-PER', '##nueva', 0.5),
      hit('O', 'please'),
    ];
    const { spans } = alignTokens(text, tokens, 0);
    expect(spans[0]?.confidence).toBeCloseTo(0.7, 5);
  });

  it('snaps a fragment span forward to the whole-word boundary', () => {
    const text = 'The Bathroom Turned Cold Yesterday';
    const tokens = [
      hit('O', 'The'),
      hit('B-MISC', 'Bathroom', 0.6),
      hit('I-MISC', 'Tu', 0.5),
      hit('O', '##rned'),
      hit('O', 'Cold'),
      hit('O', 'Yesterday'),
    ];
    const { spans, alignmentFailed } = alignTokens(text, tokens, 0);
    expect(alignmentFailed).toBe(false);
    expect(spans).toHaveLength(1);
    expect(surface(text, spans[0] ?? { start: 0, end: 0 })).toBe('Bathroom Turned');
  });

  it('snaps a fragment span backward to the whole-word start', () => {
    const text = 'OConnor here';
    const tokens = [hit('O', 'O'), hit('B-PER', 'Connor', 0.8), hit('O', 'here')];
    const { spans } = alignTokens(text, tokens, 0);
    expect(spans).toHaveLength(1);
    expect(surface(text, spans[0] ?? { start: 0, end: 0 })).toBe('OConnor');
  });

  it("snaps through apostrophes and hyphens ('Raley's', 'Gonzalez-Ruiz')", () => {
    const text = "Maria Gonzalez-Ruiz called from Raley's today";
    const tokens = [
      hit('B-PER', 'Maria', 0.99),
      hit('I-PER', 'Gonzalez', 0.98),
      hit('O', '-'),
      hit('O', 'Ruiz'),
      hit('O', 'called'),
      hit('O', 'from'),
      hit('B-ORG', 'Raley', 0.9),
      hit('O', "'"),
      hit('O', 's'),
      hit('O', 'today'),
    ];
    const { spans } = alignTokens(text, tokens, 0);
    const surfaces = spans.map((s) => surface(text, s));
    expect(surfaces).toContain('Maria Gonzalez-Ruiz');
    expect(surfaces).toContain("Raley's");
  });

  it('keeps the cursor synchronized so later O and entity tokens still align after a snap', () => {
    const text = 'The Bathroom Turned Cold near John Smith';
    const tokens = [
      hit('O', 'The'),
      hit('B-MISC', 'Bathroom', 0.6),
      hit('I-MISC', 'Tu', 0.5),
      hit('O', '##rned'),
      hit('O', 'Cold'),
      hit('O', 'near'),
      hit('B-PER', 'John', 0.99),
      hit('I-PER', 'Smith', 0.97),
    ];
    const { spans, alignmentFailed } = alignTokens(text, tokens, 0);
    expect(alignmentFailed).toBe(false);
    const surfaces = spans.map((s) => surface(text, s));
    expect(surfaces).toContain('John Smith');
  });

  it('raises alignmentFailed on an [UNK] entity piece and emits no guessed span', () => {
    const text = 'call Jorg now';
    const tokens = [hit('O', 'call'), hit('B-PER', '[UNK]', 0.9), hit('O', 'now')];
    const { spans, alignmentFailed } = alignTokens(text, tokens, 0);
    expect(alignmentFailed).toBe(true);
    expect(spans).toHaveLength(0);
  });

  it('applies the chunk offset to snapped spans', () => {
    const text = 'hi John Smith';
    const tokens = [hit('O', 'hi'), hit('B-PER', 'John', 0.99), hit('I-PER', 'Smith', 0.97)];
    const { spans } = alignTokens(text, tokens, 250);
    expect(spans[0]?.start).toBe(3 + 250);
    expect(spans[0]?.end).toBe(13 + 250);
  });
});
