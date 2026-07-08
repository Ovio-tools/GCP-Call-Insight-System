import { residualScan, type ResidualScanResult } from './residual-scan.js';
import { mergeDetections } from './spans.js';
import { tokenize, type TokenizedResult } from './tokenize.js';
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
  const { spans, disagreement } = mergeDetections(
    input.detectorResults.flatMap((r) => [...r.detections]),
  );
  const tokenized = tokenize(input.text, spans);
  const residual = residualScan({
    redactedText: tokenized.redactedText,
    vaultPlaintexts: tokenized.vaultEntries.map((e) => e.plaintext),
    denyTerms: input.denyTerms,
  });
  return { spans, disagreement, tokenized, residual };
}
