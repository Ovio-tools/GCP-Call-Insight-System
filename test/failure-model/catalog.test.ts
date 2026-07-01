import { describe, expect, it } from 'vitest';
import {
  CALLS_STATE,
  ERROR_CODES,
  REMEDIATION_CATALOG,
  ROOT_CAUSE_CATEGORIES,
  SAME_AS_IMMEDIATE,
  type ErrorCode,
  catalogFor,
  rootCauseCategorySchema,
} from '../../src/failure-model/index.js';

describe('remediation catalog', () => {
  it('has a complete entry for every error code and every root-cause category', () => {
    const members = new Set<string>([...ERROR_CODES, ...ROOT_CAUSE_CATEGORIES]);
    for (const code of members) {
      const entry = catalogFor(code as ErrorCode);

      expect(entry.impact.length).toBeGreaterThan(0);
      expect(entry.remediationNow.length).toBeGreaterThan(0);
      // longer-term fix: real non-empty text OR the explicit sentinel
      expect(entry.remediationFix.length).toBeGreaterThan(0);
      expect(typeof entry.dataSafe).toBe('boolean');
      expect(CALLS_STATE).toContain(entry.callsState);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.runbookRef.length).toBeGreaterThan(0);
    }
  });

  it('allows "same as immediate" as an explicit longer-term fix', () => {
    // At least one entry uses the sentinel, and the sentinel is a non-empty string.
    expect(SAME_AS_IMMEDIATE.length).toBeGreaterThan(0);
    const usesSentinel = Object.values(REMEDIATION_CATALOG).some(
      (e) => e.remediationFix === SAME_AS_IMMEDIATE,
    );
    expect(usesSentinel).toBe(true);
  });

  it('covers exactly the error codes (no extra, no missing) — 1:1 category mapping', () => {
    expect(Object.keys(REMEDIATION_CATALOG).sort()).toEqual([...ERROR_CODES].sort());
    for (const [code, entry] of Object.entries(REMEDIATION_CATALOG)) {
      expect(rootCauseCategorySchema.safeParse(entry.rootCauseCategory).success).toBe(true);
      expect(entry.rootCauseCategory).toBe(code);
    }
  });

  it('has no UNKNOWN fallback and throws on an unknown code', () => {
    expect(Object.keys(REMEDIATION_CATALOG)).not.toContain('UNKNOWN');
    expect(() => catalogFor('UNKNOWN' as ErrorCode)).toThrow();
  });

  it('models the two held workflow states as held, per the spec', () => {
    // Emitted only when the transcript never arrives and the call is held (§3.2).
    expect(catalogFor('DIALPAD_TRANSCRIPT_MISSING').callsState).toBe('held');
    // A weak match holds with weak_servicetitan_match and writes nothing (§12.1).
    expect(catalogFor('SERVICETITAN_MATCH_WEAK').callsState).toBe('held');
  });
});
