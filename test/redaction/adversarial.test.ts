import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CaseOutcome,
  DOMINATED_RESIDUAL_CATEGORIES,
  buildFullStack,
  corpusConfig,
  isCaught,
  loadCorpus,
  runStack,
} from './_corpus.js';
import { hasNerModel } from './_ner.js';

/**
 * The Task 4.1 adversarial gate: variants engineered to defeat single layers
 * (spelled-out letters/digits, lowercase runs, Unicode confusables, punctuation
 * injection, suffix-less addresses, per-letter dashes). Unlike the corpus gate
 * there is NO recall percentage here — every labeled value must be redacted or
 * the call held. None may pass.
 */
const SUITE_TIMEOUT = 300_000;

describe.skipIf(!hasNerModel)('adversarial redaction gate', () => {
  const corpus = loadCorpus('adversarial.json');
  const { riskThreshold } = corpusConfig();
  const outcomes = new Map<string, CaseOutcome>();

  beforeAll(async () => {
    const detectors = buildFullStack(corpus.denyTerms);
    for (const c of corpus.cases) {
      outcomes.set(c.id, await runStack(detectors, corpus.denyTerms, c.text, riskThreshold));
    }
  }, SUITE_TIMEOUT);

  it('every adversarial value is redacted or held — none passes', () => {
    const leaks: string[] = [];
    for (const c of corpus.cases) {
      const outcome = outcomes.get(c.id)!;
      for (const entity of c.entities) {
        if (!isCaught(outcome, entity.value)) {
          leaks.push(`${c.id} [${entity.type}] (held=${String(outcome.held)})`);
        }
      }
    }
    expect(leaks, `adversarial PII would egress: ${leaks.join(', ')}`).toEqual([]);
  });

  it('expectHold adversarial cases actually hold', () => {
    for (const c of corpus.cases.filter((x) => x.expectHold)) {
      const outcome = outcomes.get(c.id)!;
      expect(outcome.held, `${c.id} should hold (reasons: ${outcome.reasons.join(',')})`).toBe(
        true,
      );
    }
  });

  it('superset gate (ADR 0007): no dominated residual category fires on ANY case', () => {
    for (const c of corpus.cases) {
      const outcome = outcomes.get(c.id)!;
      const fired = Object.keys(outcome.residualCounts).filter((k) =>
        (DOMINATED_RESIDUAL_CATEGORIES as readonly string[]).includes(k),
      );
      expect(fired, `${c.id}: dominated residual categories fired: ${fired.join(',')}`).toEqual([]);
    }
  });
});
