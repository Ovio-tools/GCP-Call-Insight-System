import { RISK_REASONS, type RiskReason } from './risk-reasons.js';
import type { Detection, RiskSignal } from './types.js';

/**
 * Reason-based risk scoring (Task 4.1): explicit reasons instead of one
 * unexplained coverage number. The score is the capped sum of the triggered
 * reasons' weights; `forcedHold` and `outputSafe` carry the two decisions the
 * stage handler needs beyond the number itself.
 */

export interface RiskResult {
  /** min(1, Σ triggered weights). */
  score: number;
  /** Distinct triggered reasons (string codes only — safe for logs/detail). */
  reasons: RiskReason[];
  /** A triggered reason alone mandates a hold, regardless of the threshold. */
  forcedHold: boolean;
  /** True iff every triggered reason is safe_after_redaction — only then may a
   * held call keep its clean_transcripts row. */
  outputSafe: boolean;
}

export function scoreRisk(signals: readonly RiskSignal[]): RiskResult {
  const reasons = [...new Set(signals.map((s) => s.reason))];
  const score = Math.min(
    1,
    reasons.reduce((sum, r) => sum + RISK_REASONS[r].weight, 0),
  );
  const forcedHold = reasons.some((r) => RISK_REASONS[r].forcedHold);
  const outputSafe = reasons.every((r) => RISK_REASONS[r].safety === 'safe_after_redaction');
  return { score, reasons, forcedHold, outputSafe };
}

/**
 * Hold when a forced reason triggered OR the score reaches the configured
 * threshold. `>=` (not `>`) plus the explicit flag means forced reasons hold
 * even with REDACTION_RISK_THRESHOLD configured at its maximum of 1.
 */
export function shouldHoldForRisk(result: RiskResult, threshold: number): boolean {
  return result.forcedHold || result.score >= threshold;
}

/** More detections per 1000 chars than this ⇒ high_entity_density. */
const DENSITY_PER_1000_CHARS = 15;

/** Density is meaningless on a handful of spans: a short transcript with two
 * detections is normal, not dense. The signal needs volume to mean anything. */
const MIN_SPANS_FOR_DENSITY = 5;

/** Transcripts shorter than this give NER too little context to be trusted. */
const SHORT_TRANSCRIPT_CHARS = 80;

export interface SpanSignalInput {
  text: string;
  spans: readonly Detection[];
  /** From mergeDetections: any cross-type overlap. */
  disagreement: boolean;
  /** REDACTION_NER_MIN_SCORE; omitted ⇒ no confidence-based signal here (the NER
   * detector also raises it itself — duplicates collapse in scoreRisk). */
  nerMinScore?: number;
}

/** Signals derived from the merged spans + text shape (the detectors raise their
 * own internal signals; both feed scoreRisk together). */
export function deriveSpanSignals(input: SpanSignalInput): RiskSignal[] {
  const reasons = new Set<RiskReason>();

  if (input.text.length < SHORT_TRANSCRIPT_CHARS) reasons.add('short_transcript');
  if (input.disagreement) reasons.add('detector_disagreement');
  if (input.spans.some((s) => s.entityType === 'deny_list')) reasons.add('deny_list_hit');

  const density = (input.spans.length / Math.max(1, input.text.length)) * 1000;
  if (input.spans.length >= MIN_SPANS_FOR_DENSITY && density > DENSITY_PER_1000_CHARS) {
    reasons.add('high_entity_density');
  }

  if (
    input.nerMinScore !== undefined &&
    input.spans.some((s) => s.confidence !== undefined && s.confidence < input.nerMinScore!)
  ) {
    reasons.add('ner_low_confidence');
  }

  return [...reasons].map((reason) => ({ reason }));
}
