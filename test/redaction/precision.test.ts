import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildFullStack,
  corpusConfig,
  loadCorpus,
  normalizeValue,
  runStack,
  type CaseOutcome,
} from './_corpus.js';
import { hasNerModel } from './_ner.js';

/**
 * The ADR 0006 precision gate — the mirror of the recall gate. Runs the FULL
 * real detection stack over trade-call text whose listed values are NOT PII
 * under the signed-off entity-type policy (bare cities, business names, rooms,
 * fixtures) and asserts:
 *
 *  1. no case is held — over-redaction of these shapes was holding 100% of real
 *     calls via vault_value_reintroduced;
 *  2. every `survivingValues` entry is still present in the redacted output
 *     (i.e. genuinely not redacted, not merely "call continued");
 *  3. specifically, no residual_scan_hit fires — the exact regression this
 *     change removes.
 *
 * `acceptOverRedaction` values may legitimately lose a person-shaped fragment
 * ("Bob's", "Raley's") to the PER model — those assert only not-held.
 */

const corpus = loadCorpus('precision.json');
const { riskThreshold } = corpusConfig();

describe.skipIf(!hasNerModel)('redaction precision gate (ADR 0006)', () => {
  const outcomes = new Map<string, CaseOutcome>();

  beforeAll(async () => {
    const detectors = buildFullStack(corpus.denyTerms);
    for (const c of corpus.cases) {
      outcomes.set(c.id, await runStack(detectors, corpus.denyTerms, c.text, riskThreshold));
    }
  }, 300_000);

  it('holds NO precision case (common trade words must not trigger holds)', () => {
    const held = corpus.cases
      .filter((c) => outcomes.get(c.id)?.held)
      .map((c) => `${c.id} [${(outcomes.get(c.id)?.reasons ?? []).join(', ')}]`);
    expect(held, `held precision cases (id [risk reasons]): ${held.join('; ')}`).toEqual([]);
  });

  it('leaves every non-PII survivingValue un-redacted in the output', () => {
    const redacted: string[] = [];
    for (const c of corpus.cases) {
      const outcome = outcomes.get(c.id);
      if (!outcome) continue;
      const normalizedOutput = normalizeValue(outcome.redactedText);
      for (const value of c.survivingValues ?? []) {
        if (!normalizedOutput.includes(normalizeValue(value))) {
          redacted.push(`${c.id}: "${value}"`);
        }
      }
    }
    expect(redacted, `over-redacted values: ${redacted.join('; ')}`).toEqual([]);
  });

  it('raises no residual_scan_hit on any precision case', () => {
    const hits = corpus.cases
      .filter((c) => (outcomes.get(c.id)?.reasons ?? []).includes('residual_scan_hit'))
      .map((c) => c.id);
    expect(hits).toEqual([]);
  });
});
