import { describe, expect, it } from 'vitest';
import { composeRedaction } from '../../src/redaction/compose.js';
import { repairToResidualClean } from '../../src/redaction/repair.js';
import { residualScan } from '../../src/redaction/residual-scan.js';
import type { Detection } from '../../src/redaction/types.js';

/**
 * The repair fixpoint (ADR 0007): after merge+tokenize, re-run the residual
 * mirrors over the effective text (covered spans blanked — exactly the
 * residual's token-stripped view), convert hits back to original-text spans,
 * re-merge, re-tokenize, iterate. Exit requires the residual's own exported
 * vault predicate to be clean. These tests drive it with hand-built span sets
 * (no NER model needed).
 */

const name = (start: number, end: number): Detection => ({
  start,
  end,
  entityType: 'name',
  detector: 'ner',
});

const finalScan = (
  redactedText: string,
  vaultPlaintexts: string[],
  denyTerms: string[] = [],
): Record<string, number> => residualScan({ redactedText, vaultPlaintexts, denyTerms }).counts;

describe('repairToResidualClean', () => {
  it('propagates a vaulted name to a punctuation-split reintroduction with the SAME token', () => {
    const text =
      'David Rolando called about the leak. Please give Mister David? Rolando. a call back today.';
    const first = text.indexOf('David Rolando');
    const repaired = repairToResidualClean({
      text,
      spans: [name(first, first + 'David Rolando'.length)],
      denyTerms: [],
    });

    expect(repaired.converged).toBe(true);
    expect(repaired.tokenized.redactedText).not.toContain('Rolando');
    // Same normalized surface + same entity type ⇒ ONE token, ONE vault entry.
    expect(repaired.tokenized.vaultEntries).toHaveLength(1);
    expect(repaired.tokenized.redactedText.match(/\[NAME_1\]/g)).toHaveLength(2);
    expect(
      finalScan(
        repaired.tokenized.redactedText,
        repaired.tokenized.vaultEntries.map((e) => e.plaintext),
      ),
    ).toEqual({});

    // Idempotent: repairing again from the same input yields the same output.
    const again = repairToResidualClean({
      text,
      spans: [name(first, first + 'David Rolando'.length)],
      denyTerms: [],
    });
    expect(again.tokenized.redactedText).toBe(repaired.tokenized.redactedText);
  });

  it('catches a digit run concatenated ACROSS a redacted span', () => {
    const text = 'the parts are 123456 Bob 654321 on the sheet';
    const bob = text.indexOf('Bob');
    const repaired = repairToResidualClean({ text, spans: [name(bob, bob + 3)], denyTerms: [] });

    expect(repaired.converged).toBe(true);
    expect(repaired.tokenized.redactedText).not.toContain('123456');
    expect(repaired.tokenized.redactedText).not.toContain('654321');
    expect(
      finalScan(
        repaired.tokenized.redactedText,
        repaired.tokenized.vaultEntries.map((e) => e.plaintext),
      ),
    ).toEqual({});
  });

  it('catches a spelled-digit run concatenated across a redacted span', () => {
    const text = 'it is five five five Bob one two three four thanks';
    const bob = text.indexOf('Bob');
    const repaired = repairToResidualClean({ text, spans: [name(bob, bob + 3)], denyTerms: [] });

    expect(repaired.converged).toBe(true);
    expect(
      finalScan(
        repaired.tokenized.redactedText,
        repaired.tokenized.vaultEntries.map((e) => e.plaintext),
      ),
    ).toEqual({});
  });

  it('catches a greeting shape created by redaction', () => {
    const text = 'hello my name is acme Rodriguez and the heater is out';
    const acme = text.indexOf('acme');
    const repaired = repairToResidualClean({
      text,
      spans: [{ start: acme, end: acme + 4, entityType: 'deny_list', detector: 'deny_list' }],
      denyTerms: ['acme'],
    });

    expect(repaired.converged).toBe(true);
    expect(repaired.tokenized.redactedText).not.toContain('Rodriguez');
    expect(
      finalScan(
        repaired.tokenized.redactedText,
        repaired.tokenized.vaultEntries.map((e) => e.plaintext),
        ['acme'],
      ),
    ).toEqual({});
  });

  it('converges across multiple iterations (vault fill exposes a digit concat)', () => {
    const text = 'David read 123 David 4567 to me';
    const first = text.indexOf('David');
    const repaired = repairToResidualClean({
      text,
      spans: [name(first, first + 5)],
      denyTerms: [],
    });

    expect(repaired.converged).toBe(true);
    expect(repaired.iterations).toBeGreaterThanOrEqual(2);
    expect(repaired.tokenized.redactedText).not.toContain('David');
    expect(repaired.tokenized.redactedText).not.toContain('4567');
    expect(
      finalScan(
        repaired.tokenized.redactedText,
        repaired.tokenized.vaultEntries.map((e) => e.plaintext),
      ),
    ).toEqual({});
  });

  it('never propagates values under 3 normalized chars', () => {
    const text = 'I broke it. I called. I waited.';
    const repaired = repairToResidualClean({ text, spans: [name(0, 1)], denyTerms: [] });

    expect(repaired.converged).toBe(true);
    // Only the original span is redacted; the later standalone "I"s survive.
    expect(repaired.tokenized.redactedText).toContain('. I called.');
  });

  it('reports converged:false when the iteration budget is exhausted', () => {
    const text = 'the parts are 123456 Bob 654321 on the sheet';
    const bob = text.indexOf('Bob');
    const repaired = repairToResidualClean({
      text,
      spans: [name(bob, bob + 3)],
      denyTerms: [],
      maxIterations: 0,
    });
    expect(repaired.converged).toBe(false);
  });
});

describe('composeRedaction with repair', () => {
  it('the composed residual scan over the final output is clean for a repaired call', () => {
    const text = 'Rosalind Nakamura called; give Rosalind Nakamura the estimate';
    const composed = composeRedaction({
      text,
      detectorResults: [
        {
          detections: [{ start: 0, end: 17, entityType: 'name', detector: 'ner' }],
          riskSignals: [],
        },
      ],
      denyTerms: [],
    });
    expect(composed.residual.hits).toHaveLength(0);
    expect(composed.tokenized.redactedText).not.toContain('Nakamura');
    expect(composed.tokenized.redactedText.match(/\[NAME_1\]/g)).toHaveLength(2);
  });
});
