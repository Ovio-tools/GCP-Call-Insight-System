import { describe, expect, it } from 'vitest';
import { isValidDateInput, toDateBounds } from '../../src/knowledge/query.js';

/**
 * Date-range parsing (Findings 7 & 3): date-only values map to UTC day boundaries (a date-only `to`
 * becomes the NEXT UTC day so the named day is included); full ISO timestamps parse deterministically,
 * and an offset-less timestamp is treated as UTC. `from >= to` is rejected. Boundary inclusion/
 * exclusion against real rows is covered in query.test.ts (DB).
 */

describe('isValidDateInput', () => {
  it('accepts date-only YYYY-MM-DD', () => {
    expect(isValidDateInput('2026-07-05')).toBe(true);
  });

  it('accepts the three ISO timestamp forms', () => {
    expect(isValidDateInput('2026-07-05T12:00:00Z')).toBe(true);
    expect(isValidDateInput('2026-07-05T07:00:00-05:00')).toBe(true);
    expect(isValidDateInput('2026-07-05T12:00:00')).toBe(true); // offset-less
  });

  it('rejects garbage and impossible dates', () => {
    for (const bad of ['not-a-date', '2026-13-01', '2026-07-32', '07/05/2026', '2026-07']) {
      expect(isValidDateInput(bad), bad).toBe(false);
    }
  });

  it('rejects impossible calendar days in a full ISO timestamp (no silent normalization)', () => {
    // new Date('2026-02-30T12:00:00Z') would roll forward to Mar 2 — must be rejected instead.
    for (const bad of [
      '2026-02-30T12:00:00Z',
      '2026-02-30T12:00:00',
      '2026-02-30T07:00:00-05:00',
      '2026-13-01T00:00:00Z',
      '2026-06-31T09:30:00Z',
    ]) {
      expect(isValidDateInput(bad), bad).toBe(false);
    }
  });
});

describe('toDateBounds', () => {
  it('maps a date-only from to start-of-day UTC and to to the next UTC day', () => {
    const { fromInclusive, toExclusive } = toDateBounds({ from: '2026-07-05', to: '2026-07-05' });
    expect(fromInclusive?.toISOString()).toBe('2026-07-05T00:00:00.000Z');
    // to is the next UTC day so the named day (07-05) is included by `< toExclusive`.
    expect(toExclusive?.toISOString()).toBe('2026-07-06T00:00:00.000Z');
  });

  it('parses the offset form and the offset-less form (treated as UTC) to the same instant', () => {
    const offset = toDateBounds({ from: '2026-07-05T07:00:00-05:00' }).fromInclusive;
    expect(offset?.toISOString()).toBe('2026-07-05T12:00:00.000Z');

    const utcExplicit = toDateBounds({ from: '2026-07-05T12:00:00Z' }).fromInclusive;
    const utcImplied = toDateBounds({ from: '2026-07-05T12:00:00' }).fromInclusive;
    expect(utcExplicit?.toISOString()).toBe('2026-07-05T12:00:00.000Z');
    expect(utcImplied?.toISOString()).toBe('2026-07-05T12:00:00.000Z');
  });

  it('leaves an omitted bound undefined', () => {
    const bounds = toDateBounds({});
    expect(bounds.fromInclusive).toBeUndefined();
    expect(bounds.toExclusive).toBeUndefined();
  });

  it('rejects from >= to (a full-timestamp equal range)', () => {
    expect(() =>
      toDateBounds({ from: '2026-07-05T12:00:00Z', to: '2026-07-05T12:00:00Z' }),
    ).toThrow();
    expect(() => toDateBounds({ from: '2026-07-06', to: '2026-07-05' })).toThrow();
  });

  it('accepts a same-day date-only range (from < resolved to)', () => {
    expect(() => toDateBounds({ from: '2026-07-05', to: '2026-07-05' })).not.toThrow();
  });
});
