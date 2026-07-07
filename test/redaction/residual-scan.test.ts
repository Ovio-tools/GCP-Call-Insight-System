import { describe, expect, it } from 'vitest';
import { residualScan } from '../../src/redaction/residual-scan.js';

function scan(redactedText: string, vaultPlaintexts: string[] = [], denyTerms: string[] = []) {
  return residualScan({ redactedText, vaultPlaintexts, denyTerms });
}

describe('residualScan', () => {
  it('passes clean redacted output', () => {
    const r = scan('[NAME_1] called about the water heater, will call back tomorrow');
    expect(r.hits).toEqual([]);
    expect(r.counts).toEqual({});
  });

  it('catches a vault original reintroduced into the output (replacement bug)', () => {
    const r = scan('ok John Smith called again', ['John Smith']);
    expect(r.counts.vault_value_reintroduced).toBe(1);
  });

  it('catches vault originals under aggressive normalization', () => {
    const r = scan('ok j-o-h-n S M I T H called', ['John Smith']);
    expect(r.counts.vault_value_reintroduced).toBe(1);
  });

  it('catches a long digit run regardless of formatting', () => {
    const r = scan('call me on 9 1 6 - 5 5 5 . 1 2 3 4 thanks');
    expect(r.counts.digit_run).toBeGreaterThanOrEqual(1);
  });

  it('catches spelled-out digit sequences', () => {
    expect(scan('five five five one two three four').counts.spelled_out_digits).toBe(1);
    expect(scan('five five five double one two three').counts.spelled_out_digits).toBe(1);
    expect(scan('five five five, oh one, two three four').counts.spelled_out_digits).toBe(1);
  });

  it('does not flag short spoken-number sequences', () => {
    expect(scan('three or four days, maybe five').hits).toEqual([]);
  });

  it('catches an email with a Unicode confusable at-sign the primary regex missed', () => {
    const r = scan('reach me at john＠example.com ok');
    expect(r.counts.email_like).toBeGreaterThanOrEqual(1);
  });

  it('catches a spelled email with a real TLD', () => {
    const r = scan('reach me at bob at example dot com ok');
    expect(r.counts.email_like).toBeGreaterThanOrEqual(1);
  });

  it('catches an address keyword near a number', () => {
    const r = scan('the house is at 4482 on that avenue somewhere');
    expect(r.counts.address_like).toBeGreaterThanOrEqual(1);
  });

  it('catches a capitalized name shape after a greeting cue', () => {
    const r = scan('hi my name is Priya thanks');
    expect(r.counts.name_like_after_greeting).toBeGreaterThanOrEqual(1);
    const r2 = scan('yes this is Deshawn Williams calling back');
    expect(r2.counts.name_like_after_greeting).toBeGreaterThanOrEqual(1);
  });

  it('does not fire the greeting cue on a properly redacted token', () => {
    const r = scan('hi my name is [NAME_1] thanks');
    expect(r.hits).toEqual([]);
  });

  it('catches deny-list terms under aggressive normalization', () => {
    const r = scan('we hired a-c-m-e p.l.u.m.b.i.n.g last year', [], ['Acme Plumbing']);
    expect(r.counts.deny_list_term).toBe(1);
  });

  it('never self-triggers on our own tokens (digits in [NAME_12] etc.)', () => {
    const r = scan('[NAME_12] and [PHONE_3456789] met at [STREET_ADDRESS_1] per [CREDIT_CARD_1]', [
      'John Smith',
    ]);
    expect(r.hits).toEqual([]);
  });

  it('reports categories and counts only — no values, no offsets', () => {
    const r = scan('ok John Smith called 9165551234', ['John Smith']);
    for (const hit of r.hits) {
      expect(Object.keys(hit)).toEqual(['category']);
    }
    expect(JSON.stringify(r)).not.toContain('John');
    expect(JSON.stringify(r)).not.toContain('916');
  });

  describe('vault_value_reintroduced — short-name substring false positives (Option B)', () => {
    it('does NOT flag a short vaulted name that only appears inside a longer word', () => {
      // "Ana" normalizes to "ana", which is a substring of "banana" — the old
      // concatenated-substring match false-holds here.
      const r = scan('the banana bread was on the counter', ['Ana']);
      expect(r.counts.vault_value_reintroduced).toBeUndefined();
    });

    it('does NOT flag a short vaulted name inside another common word', () => {
      const r = scan('see you in january for the follow up', ['Jan']);
      expect(r.counts.vault_value_reintroduced).toBeUndefined();
    });

    it('DOES flag a short vaulted name reintroduced as a standalone word (genuine leak)', () => {
      const r = scan('please call Ana back tomorrow', ['Ana']);
      expect(r.counts.vault_value_reintroduced).toBe(1);
    });

    it('DOES flag a multi-word short name reintroduced with normal spacing', () => {
      const r = scan('spoke to Jane Doe again about it', ['Jane Doe']);
      expect(r.counts.vault_value_reintroduced).toBe(1);
    });

    it('does NOT flag a multi-word short name whose tokens only appear inside other words', () => {
      // "Jan" + "doe" as substrings of "january" / "doesn't" must not collide.
      const r = scan("in january it doesn't matter", ['Jan Doe']);
      expect(r.counts.vault_value_reintroduced).toBeUndefined();
    });

    it('still catches a LONG value reintroduced even when split by punctuation (regression)', () => {
      // Long normalized values keep the aggressive concatenated match, so a
      // letter-/space-split reintroduction of a full name is still held.
      expect(
        scan('ok John Smith called again', ['John Smith']).counts.vault_value_reintroduced,
      ).toBe(1);
      expect(
        scan('ok j-o-h-n S M I T H called', ['John Smith']).counts.vault_value_reintroduced,
      ).toBe(1);
    });
  });
});
