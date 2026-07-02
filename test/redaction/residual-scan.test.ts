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
});
