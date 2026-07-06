import { describe, expect, it } from 'vitest';
import { scanKnowledgeQuery } from '../../src/knowledge/sanitize.js';

/**
 * `scanKnowledgeQuery` is PURE (Finding 1): it returns `{ safe, counts }` — categories/counts only,
 * never the value — and never logs or throws. The route decides what to do with `safe: false`.
 */
const DENY = ['verboten'];

describe('scanKnowledgeQuery', () => {
  it('is safe for a clean free-text query', () => {
    const result = scanKnowledgeQuery({ q: 'leaking water heater' }, DENY);
    expect(result.safe).toBe(true);
    expect(result.counts).toEqual({});
  });

  it('is safe when q is absent', () => {
    expect(scanKnowledgeQuery({}, DENY).safe).toBe(true);
  });

  it('flags a deny-term query and returns categories/counts only, never the value', () => {
    const result = scanKnowledgeQuery({ q: 'find verboten now' }, DENY);
    expect(result.safe).toBe(false);
    expect(Object.keys(result.counts).length).toBeGreaterThan(0);
    // counts values are numbers, keys are categories — no value leakage.
    expect(JSON.stringify(result.counts)).not.toContain('verboten');
    for (const v of Object.values(result.counts)) expect(typeof v).toBe('number');
  });

  it('flags a long digit run (residual scan category)', () => {
    const result = scanKnowledgeQuery({ q: 'call 5551234567' }, DENY);
    expect(result.safe).toBe(false);
  });

  it('does not throw on any input', () => {
    expect(() => scanKnowledgeQuery({ q: '' }, DENY)).not.toThrow();
    expect(() => scanKnowledgeQuery({ q: 'verboten' }, [])).not.toThrow();
  });
});
