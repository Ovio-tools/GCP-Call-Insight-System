import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/redaction/tokenize.js';
import type { Detection } from '../../src/redaction/types.js';

function d(start: number, end: number, entityType: Detection['entityType']): Detection {
  return { start, end, entityType, detector: 'regex' };
}

describe('tokenize', () => {
  it('replaces spans right-to-left with per-type sequential tokens', () => {
    //            0123456789012345678901234567890123456789
    const text = 'John Smith called from 9165551234 today';
    const result = tokenize(text, [d(0, 10, 'name'), d(23, 33, 'phone')]);
    expect(result.redactedText).toBe('[NAME_1] called from [PHONE_1] today');
    expect(result.vaultEntries).toEqual([
      { token: '[NAME_1]', plaintext: 'John Smith' },
      { token: '[PHONE_1]', plaintext: '9165551234' },
    ]);
    expect(result.findings).toEqual([
      { entityType: 'name', tokenRef: '[NAME_1]', normalizedValue: 'johnsmith' },
      { entityType: 'phone', tokenRef: '[PHONE_1]', normalizedValue: '9165551234' },
    ]);
  });

  it('numbers tokens per entity type in order of first occurrence', () => {
    const text = 'Ann met Bob then Ann called 5551234567';
    const result = tokenize(text, [
      d(0, 3, 'name'),
      d(8, 11, 'name'),
      d(17, 20, 'name'),
      d(28, 38, 'phone'),
    ]);
    expect(result.redactedText).toBe('[NAME_1] met [NAME_2] then [NAME_1] called [PHONE_1]');
  });

  it('assigns the SAME token to values equal after normalization (case/space/punct)', () => {
    const text = 'John Smith here; ask for john  smith. tomorrow';
    const result = tokenize(text, [d(0, 10, 'name'), d(25, 37, 'name')]);
    expect(result.redactedText).toBe('[NAME_1] here; ask for [NAME_1] tomorrow');
    // One vault entry per token, first-seen surface wins.
    expect(result.vaultEntries).toEqual([{ token: '[NAME_1]', plaintext: 'John Smith' }]);
    expect(result.findings).toHaveLength(1);
  });

  it('leaves no detected surface in the output', () => {
    const text = 'card 4111 1111 1111 1111 and email j@x.com ok';
    const result = tokenize(text, [d(5, 24, 'credit_card'), d(35, 42, 'email')]);
    expect(result.redactedText).not.toContain('4111');
    expect(result.redactedText).not.toContain('j@x.com');
    expect(result.redactedText).toContain('[CREDIT_CARD_1]');
    expect(result.redactedText).toContain('[EMAIL_1]');
  });

  it('is deterministic: same input twice gives identical output', () => {
    const text = 'Maria at 123 Main Street, phone (916) 555-1234';
    const spans = [d(0, 5, 'name'), d(9, 24, 'street_address'), d(32, 46, 'phone')];
    const a = tokenize(text, spans);
    const b = tokenize(text, spans);
    expect(a).toEqual(b);
  });

  it('handles empty spans (no-op)', () => {
    const result = tokenize('nothing to redact here', []);
    expect(result.redactedText).toBe('nothing to redact here');
    expect(result.vaultEntries).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
