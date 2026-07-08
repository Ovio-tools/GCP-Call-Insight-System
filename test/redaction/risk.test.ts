import { describe, expect, it } from 'vitest';
import { deriveSpanSignals, scoreRisk, shouldHoldForRisk } from '../../src/redaction/risk.js';
import { RISK_REASONS, type RiskReason } from '../../src/redaction/risk-reasons.js';
import type { Detection, RiskSignal } from '../../src/redaction/types.js';

const sig = (reason: RiskReason): RiskSignal => ({ reason });

function d(start: number, end: number, confidence?: number): Detection {
  return {
    start,
    end,
    entityType: 'name',
    detector: 'ner',
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

describe('scoreRisk', () => {
  it('scores zero with no signals: safe output, no hold', () => {
    const r = scoreRisk([]);
    expect(r).toEqual({ score: 0, reasons: [], forcedHold: false, outputSafe: true });
  });

  it('sums each triggered reason weight exactly once (duplicates collapse)', () => {
    const r = scoreRisk([sig('deny_list_hit'), sig('deny_list_hit'), sig('ner_low_confidence')]);
    expect(r.score).toBeCloseTo(
      RISK_REASONS.deny_list_hit.weight + RISK_REASONS.ner_low_confidence.weight,
    );
    expect(r.reasons.sort()).toEqual(['deny_list_hit', 'ner_low_confidence']);
  });

  it('caps the score at 1', () => {
    const all = (Object.keys(RISK_REASONS) as RiskReason[]).map(sig);
    expect(scoreRisk(all).score).toBe(1);
  });

  it('sets forcedHold for forced reasons', () => {
    expect(scoreRisk([sig('ner_offset_alignment_failed')]).forcedHold).toBe(true);
    expect(scoreRisk([sig('residual_scan_hit')]).forcedHold).toBe(true);
    expect(scoreRisk([sig('deny_list_hit')]).forcedHold).toBe(false);
  });

  it('outputSafe is false whenever ANY unsafe_uncertain_surface reason triggers', () => {
    for (const reason of Object.keys(RISK_REASONS) as RiskReason[]) {
      const r = scoreRisk([sig(reason)]);
      expect(r.outputSafe, reason).toBe(RISK_REASONS[reason].safety === 'safe_after_redaction');
    }
    // Mixed: one safe + one unsafe => unsafe.
    expect(scoreRisk([sig('deny_list_hit'), sig('short_transcript')]).outputSafe).toBe(false);
  });
});

describe('shouldHoldForRisk', () => {
  it('holds at or above the threshold (>= comparison)', () => {
    const r = scoreRisk([sig('transcript_chunking_truncated'), sig('address_like_ambiguous')]); // 0.5
    expect(shouldHoldForRisk(r, 0.5)).toBe(true);
    expect(shouldHoldForRisk(r, 0.51)).toBe(false);
  });

  it('forced reasons hold even with the threshold configured at 1', () => {
    const r = scoreRisk([sig('ner_offset_alignment_failed')]);
    expect(shouldHoldForRisk(r, 1)).toBe(true);
  });

  it('a sub-threshold, non-forced score does not hold', () => {
    const r = scoreRisk([sig('deny_list_hit')]);
    expect(shouldHoldForRisk(r, 0.7)).toBe(false);
  });
});

describe('deriveSpanSignals', () => {
  const text200 = 'a'.repeat(200);

  it('raises short_transcript below the minimum context length', () => {
    const signals = deriveSpanSignals({ text: 'hi it is me', spans: [], disagreement: false });
    expect(signals.some((s) => s.reason === 'short_transcript')).toBe(true);
  });

  it('raises detector_disagreement when the merge flagged one', () => {
    const signals = deriveSpanSignals({ text: text200, spans: [], disagreement: true });
    expect(signals.some((s) => s.reason === 'detector_disagreement')).toBe(true);
  });

  it('raises deny_list_hit when a deny span is present', () => {
    const spans: Detection[] = [
      { start: 0, end: 4, entityType: 'deny_list', detector: 'deny_list' },
    ];
    const signals = deriveSpanSignals({ text: text200, spans, disagreement: false });
    expect(signals.some((s) => s.reason === 'deny_list_hit')).toBe(true);
  });

  it('raises high_entity_density for unusually many detections per 1000 chars', () => {
    const spans = Array.from({ length: 8 }, (_, i) => d(i * 10, i * 10 + 5));
    const signals = deriveSpanSignals({ text: text200, spans, disagreement: false });
    expect(signals.some((s) => s.reason === 'high_entity_density')).toBe(true);
  });

  it('never derives ner_low_confidence from spans — the NER detector is its single source (ADR 0006)', () => {
    // Post-gate, no surviving NER span can sit below the threshold; the detector
    // raises the signal itself when it DROPS candidates.
    const signals = deriveSpanSignals({
      text: text200,
      spans: [d(0, 5, 0.3)],
      disagreement: false,
    });
    expect(signals.some((s) => s.reason === 'ner_low_confidence')).toBe(false);
  });

  it('is quiet on a normal transcript', () => {
    const signals = deriveSpanSignals({
      text: text200,
      spans: [d(0, 5, 0.99)],
      disagreement: false,
    });
    expect(signals).toEqual([]);
  });
});
