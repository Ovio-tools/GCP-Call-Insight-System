import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDenyListDetector } from '../../src/redaction/deny-list.js';
import { createNerDetector } from '../../src/redaction/ner-detector.js';
import { createRegexDetector } from '../../src/redaction/regex-detectors.js';
import { residualScan } from '../../src/redaction/residual-scan.js';
import { deriveSpanSignals, scoreRisk, shouldHoldForRisk } from '../../src/redaction/risk.js';
import { mergeDetections } from '../../src/redaction/spans.js';
import { tokenize } from '../../src/redaction/tokenize.js';
import type { Detector, RiskSignal } from '../../src/redaction/types.js';
import { configSchema } from '../../src/config/schema.js';
import { REQUIRED_ENV } from '../_config.js';
import { makeNerConfig } from './_ner.js';

/**
 * Shared harness for the corpus + adversarial gates: runs the FULL real detection
 * stack (NER + regex + deny-list) plus residual scan and risk scoring — the same
 * composition the stage handler uses — and reports, per case, the redacted output
 * and whether the call would be held.
 *
 * The privacy property is measured by VALUE, not offsets: a labeled value counts
 * as caught iff it does not appear (normalized) in the final output OR the call
 * was held. Never passed with PII present.
 */

export interface CorpusEntity {
  type: string;
  value: string;
}

export interface CorpusCase {
  id: string;
  text: string;
  entities: CorpusEntity[];
  /** The case is expected to hold (e.g. spelled-out digits caught by residual). */
  expectHold?: boolean;
  /** Precision corpus (ADR 0006): non-PII values that must SURVIVE redaction. */
  survivingValues?: string[];
  /** Precision corpus: values where a person-shaped fragment may legitimately be
   * redacted inside a business name ("Bob's Heating and Air") — not-held only. */
  acceptOverRedaction?: string[];
}

export interface Corpus {
  denyTerms: string[];
  cases: CorpusCase[];
}

export function loadCorpus(name: string): Corpus {
  const path = fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus;
}

/** The gate's targets/knobs come from env with the schema's defaults. */
export function corpusConfig(): { recallTarget: number; riskThreshold: number } {
  const parsed = configSchema.parse({ NODE_ENV: 'test', ...REQUIRED_ENV, ...process.env });
  return {
    recallTarget: parsed.REDACTION_RECALL_TARGET,
    riskThreshold: parsed.REDACTION_RISK_THRESHOLD,
  };
}

/** Same normalization idea as the residual scanner's value recheck. */
export function normalizeValue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CaseOutcome {
  redactedText: string;
  held: boolean;
  reasons: string[];
}

export function buildFullStack(denyTerms: string[]): Detector[] {
  return [
    createNerDetector(makeNerConfig()),
    createRegexDetector(),
    createDenyListDetector(denyTerms),
  ];
}

export async function runStack(
  detectors: readonly Detector[],
  denyTerms: string[],
  text: string,
  riskThreshold: number,
): Promise<CaseOutcome> {
  const results = await Promise.all(detectors.map((d) => d.detect(text)));
  const { spans, disagreement } = mergeDetections(results.flatMap((r) => [...r.detections]));
  const tokenized = tokenize(text, spans);
  const residual = residualScan({
    redactedText: tokenized.redactedText,
    vaultPlaintexts: tokenized.vaultEntries.map((e) => e.plaintext),
    denyTerms,
  });
  const residualHit = residual.hits.length > 0;
  const signals: RiskSignal[] = [
    ...results.flatMap((r) => [...r.riskSignals]),
    ...deriveSpanSignals({ text, spans, disagreement }),
    ...(residualHit ? [{ reason: 'residual_scan_hit' as const }] : []),
  ];
  const risk = scoreRisk(signals);
  return {
    redactedText: tokenized.redactedText,
    held: residualHit || shouldHoldForRisk(risk, riskThreshold),
    reasons: risk.reasons,
  };
}

/** True iff the labeled value cannot egress: absent from the output, or the call held. */
export function isCaught(outcome: CaseOutcome, value: string): boolean {
  if (outcome.held) return true;
  return !normalizeValue(outcome.redactedText).includes(normalizeValue(value));
}
