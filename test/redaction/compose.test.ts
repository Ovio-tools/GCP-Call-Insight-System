import { describe, expect, it } from 'vitest';
import { composeRedaction } from '../../src/redaction/compose.js';
import type { DetectorResult } from '../../src/redaction/types.js';

/**
 * composeRedaction is the ONE shared merge → tokenize → residual-scan
 * composition used by the stage handler, the corpus/adversarial/precision
 * harness, and the inspection tool — so the fixpoint (ADR 0007) cannot drift
 * between them. These tests pin the composition semantics with hand-built
 * detector results (no NER model needed).
 */

const result = (detections: DetectorResult['detections']): DetectorResult => ({
  detections,
  riskSignals: [],
});

describe('composeRedaction', () => {
  it('merges, tokenizes, and residual-scans like the stage handler', () => {
    const text = 'call John Smith at 916-555-0142 today';
    const composed = composeRedaction({
      text,
      detectorResults: [
        result([{ start: 5, end: 15, entityType: 'name', detector: 'ner' }]),
        result([{ start: 19, end: 31, entityType: 'phone', detector: 'regex' }]),
      ],
      denyTerms: [],
    });
    expect(composed.tokenized.redactedText).toBe('call [NAME_1] at [PHONE_1] today');
    expect(composed.residual.hits).toHaveLength(0);
    expect(composed.disagreement).toBe(false);
    expect(composed.spans).toHaveLength(2);
  });

  it('repairs a vaulted value surviving elsewhere instead of leaving a residual hit', () => {
    // Only the first "Rosalind Nakamura" is covered by a detector span; the
    // repair fixpoint (ADR 0007) must redact the second with the same token.
    const text = 'Rosalind Nakamura called; give Rosalind Nakamura the estimate';
    const composed = composeRedaction({
      text,
      detectorResults: [result([{ start: 0, end: 17, entityType: 'name', detector: 'ner' }])],
      denyTerms: [],
    });
    expect(composed.residual.hits).toHaveLength(0);
    expect(composed.tokenized.redactedText).toBe('[NAME_1] called; give [NAME_1] the estimate');
  });

  it('flags cross-type overlap as disagreement', () => {
    const text = 'the value 123 Main Street here';
    const composed = composeRedaction({
      text,
      detectorResults: [
        result([{ start: 10, end: 25, entityType: 'street_address', detector: 'regex' }]),
        result([{ start: 14, end: 18, entityType: 'name', detector: 'ner' }]),
      ],
      denyTerms: [],
    });
    expect(composed.disagreement).toBe(true);
  });
});
