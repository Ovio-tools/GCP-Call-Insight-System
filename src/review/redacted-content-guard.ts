import { residualScan } from '../redaction/residual-scan.js';

/**
 * A value-level residual-PII guard over a redacted transcript before it is serialized into the
 * review detail (Task 6.2, plan §"Detail"). Defense-in-depth over the redact-stage `outputSafe`
 * invariant: even a live `clean_transcripts` row is rescanned here, and a hit WITHHOLDS the text.
 *
 * Uses the lower-level single-STRING scanner `residualScan` (NOT the phrase-list
 * `scanPhrasesForResidual`, which is for extract's `customer_language`). `vaultPlaintexts` is
 * empty — the review surface never has the raw vault values here (reveal is a separate elevated
 * path), so this is purely a shape/deny-list recheck of the redacted text. Returns counts +
 * categories only, never values, so the result is safe to log.
 */
export interface RedactedContentGuardResult {
  safe: boolean;
  categories: string[];
}

export function guardRedactedContent(
  redactedText: string,
  denyTerms: readonly string[],
): RedactedContentGuardResult {
  const scan = residualScan({ redactedText, vaultPlaintexts: [], denyTerms });
  return { safe: scan.hits.length === 0, categories: Object.keys(scan.counts) };
}
