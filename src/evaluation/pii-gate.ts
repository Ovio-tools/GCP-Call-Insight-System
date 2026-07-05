import { residualScan } from '../redaction/residual-scan.js';

/**
 * The residual-PII gate over a redacted transcript before it becomes a labeled example (Task 6.3).
 * A counts-only check — never values — over the same `residualScan` the redact stage uses, run here
 * as defense-in-depth: the transcript is already redaction-boundary clean, but a labeled example is
 * a durable de-identified asset, so it is re-scanned and a hit is recorded as a content-free `pii`
 * rejection. `vaultPlaintexts` is empty (the sync never holds raw vault values).
 */
export function validateRedactedInputSafe(
  redactedText: string,
  denyTerms: readonly string[],
): { safe: true } | { safe: false; counts: Record<string, number> } {
  const scan = residualScan({ redactedText, vaultPlaintexts: [], denyTerms });
  if (scan.hits.length === 0) return { safe: true };
  return { safe: false, counts: scan.counts };
}
