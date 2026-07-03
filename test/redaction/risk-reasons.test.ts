import { describe, expect, it } from 'vitest';
import { RISK_REASONS, type RiskReason } from '../../src/redaction/risk-reasons.js';

describe('risk reasons table', () => {
  const entries = Object.entries(RISK_REASONS) as [RiskReason, (typeof RISK_REASONS)[RiskReason]][];

  it('every reason has a weight in (0, 1]', () => {
    for (const [reason, meta] of entries) {
      expect(meta.weight, reason).toBeGreaterThan(0);
      expect(meta.weight, reason).toBeLessThanOrEqual(1);
    }
  });

  it('every reason declares a safety classification', () => {
    for (const [reason, meta] of entries) {
      expect(['safe_after_redaction', 'unsafe_uncertain_surface'], reason).toContain(meta.safety);
    }
  });

  it('forced-hold reasons carry full weight and are unsafe', () => {
    for (const [reason, meta] of entries) {
      if (meta.forcedHold) {
        expect(meta.weight, reason).toBe(1);
        expect(meta.safety, reason).toBe('unsafe_uncertain_surface');
      }
    }
  });

  it('contains the reasons the pipeline depends on', () => {
    const reasons = Object.keys(RISK_REASONS);
    for (const required of [
      'ner_low_confidence',
      'ner_offset_alignment_failed',
      'transcript_chunking_truncated',
      'address_like_ambiguous',
      'detector_disagreement',
      'deny_list_hit',
      'high_entity_density',
      'short_transcript',
      'residual_scan_hit',
    ]) {
      expect(reasons).toContain(required);
    }
  });

  it('offset-alignment failure and residual hits force a hold', () => {
    expect(RISK_REASONS.ner_offset_alignment_failed.forcedHold).toBe(true);
    expect(RISK_REASONS.residual_scan_hit.forcedHold).toBe(true);
  });
});
