/**
 * Risk-reason vocabulary for the redaction stage (Task 4.1) — a leaf module with no
 * imports, shared by `types.ts` (detector risk signals) and `risk.ts` (the scorer)
 * so neither creates an import cycle.
 *
 * The stage reports explicit reasons instead of one unexplained coverage number
 * (build plan §4.1). Each reason carries:
 *
 * - `weight` — its contribution to the risk score (scores cap at 1).
 * - `forcedHold` — the reason alone holds the call, regardless of the configured
 *   threshold. Used where the output text may contain PII we KNOW we could not
 *   place or remove.
 * - `safety` — whether the redacted output text is still trustworthy when this
 *   reason fires:
 *   - `safe_after_redaction`: everything suspected WAS tokenized; the text is fully
 *     redacted per our detectors, merely low-confidence. A held call may keep its
 *     clean_transcripts row for the review surface.
 *   - `unsafe_uncertain_surface`: detection/coverage itself is in doubt — the text
 *     may still contain unredacted PII and must never be written to
 *     clean_transcripts (an unencrypted, app_role table).
 */
export const RISK_REASONS = {
  /** NER candidate spans below REDACTION_NER_MIN_SCORE were DROPPED, not redacted
   * (ADR 0006 precision gate) — a suspected-entity surface remains in the output, so
   * the text is not trustworthy for clean_transcripts if the call ends up held. */
  ner_low_confidence: { weight: 0.15, forcedHold: false, safety: 'unsafe_uncertain_surface' },

  /** Detectors disagreed on overlapping spans; the merge redacted the union. */
  detector_disagreement: { weight: 0.1, forcedHold: false, safety: 'safe_after_redaction' },

  /** A client deny-list term was found (and redacted). */
  deny_list_hit: { weight: 0.1, forcedHold: false, safety: 'safe_after_redaction' },

  /** Unusually many detections per 1000 chars — the transcript is PII-dense. */
  high_entity_density: { weight: 0.1, forcedHold: false, safety: 'safe_after_redaction' },

  /** An NER candidate span could NOT be aligned back to source offsets, so it was
   * not redacted. The output may contain a suspected name/location/org verbatim. */
  ner_offset_alignment_failed: { weight: 1, forcedHold: true, safety: 'unsafe_uncertain_surface' },

  /** A chunk exceeded the model's window and was truncated — part of the text was
   * never NER-scanned. */
  transcript_chunking_truncated: {
    weight: 0.3,
    forcedHold: false,
    safety: 'unsafe_uncertain_surface',
  },

  /** An address-like phrase (number + capitalized words, no street suffix) remains
   * in the output text un-redacted. */
  address_like_ambiguous: { weight: 0.2, forcedHold: false, safety: 'unsafe_uncertain_surface' },

  /** Too little text for NER to have usable context. */
  short_transcript: { weight: 0.1, forcedHold: false, safety: 'unsafe_uncertain_surface' },

  /** The independent residual scan found something in the redacted output. Also a
   * direct hold path (residual_pii_detected). */
  residual_scan_hit: { weight: 1, forcedHold: true, safety: 'unsafe_uncertain_surface' },
} as const satisfies Record<
  string,
  {
    weight: number;
    forcedHold: boolean;
    safety: 'safe_after_redaction' | 'unsafe_uncertain_surface';
  }
>;

export type RiskReason = keyof typeof RISK_REASONS;

export type RiskSafety = (typeof RISK_REASONS)[RiskReason]['safety'];
