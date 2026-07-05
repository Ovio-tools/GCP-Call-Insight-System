import { describe, expect, it } from 'vitest';
import { validateRedactedInputSafe } from '../../src/evaluation/pii-gate.js';

/**
 * The residual-PII gate over a redacted transcript before it becomes a labeled example (Task 6.3).
 * Counts/categories only — never values. Defense-in-depth over the redaction boundary.
 */
describe('validateRedactedInputSafe', () => {
  it('passes clean redacted text', () => {
    const result = validateRedactedInputSafe(
      'The customer wants a [NAME_1] water heater install.',
      [],
    );
    expect(result).toEqual({ safe: true });
  });

  it('fails on residual PII and returns counts-only (no value)', () => {
    const result = validateRedactedInputSafe('call me back at 5551234567 today', []);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.counts.digit_run).toBeGreaterThanOrEqual(1);
      // The result carries only category→count, never the offending value.
      expect(JSON.stringify(result.counts)).not.toContain('5551234567');
    }
  });

  it('fails on a deny-list term', () => {
    const result = validateRedactedInputSafe('we compete with Acme Plumbing', ['Acme Plumbing']);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.counts.deny_list_term).toBeGreaterThanOrEqual(1);
  });
});
