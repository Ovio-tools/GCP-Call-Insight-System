import { repairToResidualClean } from './repair.js';
import { residualScan, type ResidualScanResult } from './residual-scan.js';
import { mergeDetections } from './spans.js';
import type { TokenizedResult } from './tokenize.js';
import type { Detection, DetectorResult } from './types.js';

/**
 * The ONE shared merge → tokenize → residual-scan composition (ADR 0007).
 *
 * The redact stage handler, the corpus/adversarial/precision test harness, and
 * the offline inspection tool previously each hand-rolled this sequence; the
 * repair fixpoint has to sit between merge and the final tokenize, so the
 * composition lives here once and all three call it — the guarantee cannot
 * drift between what CI measures, what the stage does, and what the operator
 * inspects.
 */

export interface ComposeInput {
  /** The redactable text (transcriptToRedactableText output, or a fixture). */
  text: string;
  /** One result per detector, in any order. */
  detectorResults: readonly DetectorResult[];
  denyTerms: readonly string[];
}

export interface ComposedRedaction {
  /** The final merged span set the output was tokenized with. */
  spans: readonly Detection[];
  /** True when detectors of different types overlapped (risk signal input). */
  disagreement: boolean;
  tokenized: TokenizedResult;
  /** The independent residual scan over the FINAL output. */
  residual: ResidualScanResult;
}

export function composeRedaction(input: ComposeInput): ComposedRedaction {
  const merged = mergeDetections(input.detectorResults.flatMap((r) => [...r.detections]));
  // The ADR 0007 repair fixpoint: re-run the residual mirrors over the
  // effective text until nothing the residual could hold on remains (or the
  // cap trips — then the unchanged residual scan below holds, fail closed).
  const repaired = repairToResidualClean({
    text: input.text,
    spans: merged.spans,
    denyTerms: input.denyTerms,
  });
  const residual = residualScan({
    redactedText: repaired.tokenized.redactedText,
    vaultPlaintexts: repaired.tokenized.vaultEntries.map((e) => e.plaintext),
    denyTerms: input.denyTerms,
  });
  return {
    spans: repaired.spans,
    disagreement: merged.disagreement || repaired.disagreement,
    tokenized: repaired.tokenized,
    residual,
  };
}
