import { describe, expect, it } from 'vitest';
import { mergeDetections } from '../../src/redaction/spans.js';
import type { Detection } from '../../src/redaction/types.js';

function d(
  start: number,
  end: number,
  entityType: Detection['entityType'],
  detector: Detection['detector'] = 'regex',
): Detection {
  return { start, end, entityType, detector };
}

describe('mergeDetections', () => {
  it('returns disjoint spans untouched, sorted by start', () => {
    const { spans, disagreement } = mergeDetections([d(20, 30, 'phone'), d(0, 10, 'name', 'ner')]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [20, 30],
    ]);
    expect(disagreement).toBe(false);
  });

  it('unions overlapping spans of the same type', () => {
    const { spans, disagreement } = mergeDetections([
      d(0, 12, 'name', 'ner'),
      d(8, 20, 'name', 'ner'),
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 20, entityType: 'name' });
    expect(disagreement).toBe(false);
  });

  it('unions touching (adjacent) spans of the same type', () => {
    const { spans } = mergeDetections([d(0, 10, 'phone'), d(10, 18, 'phone')]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 18 });
  });

  it('drops a strict subset span of a different type and flags disagreement', () => {
    const { spans, disagreement } = mergeDetections([
      d(0, 20, 'street_address'),
      d(5, 10, 'name', 'ner'),
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 20, entityType: 'street_address' });
    expect(disagreement).toBe(true);
  });

  it('merges a partial cross-type overlap to the union', () => {
    const { spans, disagreement } = mergeDetections([d(0, 12, 'name', 'ner'), d(8, 22, 'phone')]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(22);
    expect(disagreement).toBe(true);
  });

  it('labels cross-type merges by priority: deny_list > regex > ner', () => {
    const denyVsRegex = mergeDetections([
      d(0, 10, 'phone', 'regex'),
      d(5, 15, 'deny_list', 'deny_list'),
    ]);
    expect(denyVsRegex.spans[0]!.entityType).toBe('deny_list');

    const regexVsNer = mergeDetections([d(0, 10, 'name', 'ner'), d(5, 15, 'email', 'regex')]);
    expect(regexVsNer.spans[0]!.entityType).toBe('email');
  });

  it('keeps the lowest confidence across merged NER spans', () => {
    const { spans } = mergeDetections([
      { ...d(0, 10, 'name', 'ner'), confidence: 0.9 },
      { ...d(8, 16, 'name', 'ner'), confidence: 0.4 },
    ]);
    expect(spans[0]!.confidence).toBe(0.4);
  });

  it('handles the empty input', () => {
    const { spans, disagreement } = mergeDetections([]);
    expect(spans).toEqual([]);
    expect(disagreement).toBe(false);
  });
});
