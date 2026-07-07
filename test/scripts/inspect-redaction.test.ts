import { describe, expect, it } from 'vitest';
import {
  findContexts,
  formatCallInspection,
  type CallInspection,
} from '../../src/scripts/inspect-redaction.js';

describe('findContexts', () => {
  it('returns a bounded window around each occurrence of the value (case-insensitive)', () => {
    const contexts = findContexts('Sarah', 'Hi Sarah, this is sarah again about the job', 6);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain('Sarah');
    expect(contexts[1]?.toLowerCase()).toContain('sarah');
    // The window is trimmed and marked with an ellipsis when it does not reach the ends.
    expect(contexts[1]).toMatch(/…/);
  });

  it('returns nothing for an empty value or a value not present', () => {
    expect(findContexts('', 'anything')).toEqual([]);
    expect(findContexts('Priya', 'no such name here')).toEqual([]);
  });
});

describe('formatCallInspection', () => {
  const base: CallInspection = {
    callId: 'call-1',
    present: true,
    extractedLength: 120,
    detectionCount: 3,
    vaultValues: ['Sarah', '9165551234'],
    redactedText: 'Hi [NAME_1], and Sarah will call [PHONE_1] later',
    residualCounts: { vault_value_reintroduced: 1 },
    reintroduced: [{ value: 'Sarah', contexts: ['…and Sarah will call…'] }],
  };

  it('reports the call id, residual counts, and the reintroduced value with context', () => {
    const out = formatCallInspection(base, { full: false });
    expect(out).toContain('call-1');
    expect(out).toContain('vault_value_reintroduced');
    expect(out).toContain('Sarah');
    expect(out).toContain('…and Sarah will call…');
  });

  it('hides the full redacted text unless --full is set', () => {
    const withoutFull = formatCallInspection(base, { full: false });
    const withFull = formatCallInspection(base, { full: true });
    expect(withoutFull).not.toContain('Hi [NAME_1], and Sarah will call [PHONE_1] later');
    expect(withFull).toContain('Hi [NAME_1], and Sarah will call [PHONE_1] later');
  });

  it('reports an absent raw transcript plainly', () => {
    const out = formatCallInspection({ callId: 'gone', present: false }, { full: false });
    expect(out).toContain('gone');
    expect(out).toMatch(/no raw transcript|absent/i);
  });

  it('reports a clean pass (no residual hits) explicitly', () => {
    const clean: CallInspection = {
      callId: 'clean-1',
      present: true,
      extractedLength: 40,
      detectionCount: 1,
      vaultValues: ['Sarah'],
      redactedText: 'Hi [NAME_1] about the heater',
      residualCounts: {},
      reintroduced: [],
    };
    const out = formatCallInspection(clean, { full: false });
    expect(out).toContain('clean-1');
    expect(out).toMatch(/no residual|would PASS|pass/i);
  });
});
