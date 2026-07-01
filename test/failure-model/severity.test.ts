import { describe, expect, it } from 'vitest';
import { SEVERITY } from '../../src/db/enums.js';
import {
  DEFAULT_SEVERITY,
  ERROR_CODES,
  ROOT_CAUSE_CATEGORIES,
  type ErrorCode,
  severityFor,
} from '../../src/failure-model/index.js';

describe('severity', () => {
  it('resolves a valid severity for every error code', () => {
    for (const code of ERROR_CODES) {
      expect(SEVERITY).toContain(severityFor(code));
    }
  });

  it('resolves a valid severity for every root-cause category', () => {
    for (const category of ROOT_CAUSE_CATEGORIES) {
      expect(SEVERITY).toContain(severityFor(category));
    }
  });

  it('covers exactly the error codes, with no UNKNOWN fallback', () => {
    expect(Object.keys(DEFAULT_SEVERITY).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(DEFAULT_SEVERITY)).not.toContain('UNKNOWN');
  });

  it('throws on an unknown code (no generic fallback)', () => {
    expect(() => severityFor('UNKNOWN' as ErrorCode)).toThrow();
  });
});
