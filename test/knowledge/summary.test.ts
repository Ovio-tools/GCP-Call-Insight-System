import { describe, expect, it } from 'vitest';
import { buildSummary, humanizeLabel } from '../../src/knowledge/summary.js';
import type { KnowledgeAggregate } from '../../src/db/repositories/structured-knowledge-repo.js';

/**
 * The summary is a DETERMINISTIC local aggregation (Finding 4) over the whole filtered set — no
 * model call. Integers + humanized enum labels only; structurally PII-free. The "reflects all rows,
 * not one page" property is guaranteed by feeding it the full-set aggregate (asserted end-to-end in
 * export-semantics / routes).
 */
function aggregate(overrides: Partial<KnowledgeAggregate> = {}): KnowledgeAggregate {
  return {
    total: 3,
    minCreatedAt: new Date('2026-07-01T00:00:00Z'),
    maxCreatedAt: new Date('2026-07-05T00:00:00Z'),
    byServiceCategory: [
      { key: 'toilet', count: 2 },
      { key: 'water_heater', count: 1 },
    ],
    byCallIntent: [{ key: 'new_booking', count: 3 }],
    byUrgency: [
      { key: 'routine', count: 2 },
      { key: 'emergency', count: 1 },
    ],
    ...overrides,
  };
}

describe('humanizeLabel', () => {
  it('turns a snake_case enum into a readable label', () => {
    expect(humanizeLabel('water_heater')).toBe('Water heater');
    expect(humanizeLabel('leak_detection_or_repair')).toBe('Leak detection or repair');
    expect(humanizeLabel('new_booking')).toBe('New booking');
  });
});

describe('buildSummary', () => {
  it('carries the correct total, date span, and grouped counts', () => {
    const summary = buildSummary(aggregate());
    expect(summary.total).toBe(3);
    expect(summary.date_span.from).toBe('2026-07-01T00:00:00.000Z');
    expect(summary.date_span.to).toBe('2026-07-05T00:00:00.000Z');
    expect(summary.by_service_category).toEqual([
      { key: 'toilet', count: 2 },
      { key: 'water_heater', count: 1 },
    ]);
    expect(summary.by_urgency.find((u) => u.key === 'emergency')?.count).toBe(1);
  });

  it('writes a plain-language narrative with humanized labels and integer counts', () => {
    const { narrative } = buildSummary(aggregate());
    expect(narrative).toContain('3 records');
    expect(narrative).toContain('Toilet (2)');
    expect(narrative).toContain('Water heater (1)');
    // no raw snake_case enum leaks into the sentence
    expect(narrative).not.toContain('water_heater');
  });

  it('handles the empty set with a null date span and a clear sentence', () => {
    const summary = buildSummary(
      aggregate({
        total: 0,
        minCreatedAt: null,
        maxCreatedAt: null,
        byServiceCategory: [],
        byCallIntent: [],
        byUrgency: [],
      }),
    );
    expect(summary.total).toBe(0);
    expect(summary.date_span).toEqual({ from: null, to: null });
    expect(summary.narrative).toContain('No records');
  });

  it('is structurally free of content — only integers, enum keys, and the narrative string', () => {
    const summary = buildSummary(aggregate());
    for (const group of [summary.by_service_category, summary.by_call_intent, summary.by_urgency]) {
      for (const entry of group) {
        expect(typeof entry.key).toBe('string');
        expect(Number.isInteger(entry.count)).toBe(true);
      }
    }
  });
});
