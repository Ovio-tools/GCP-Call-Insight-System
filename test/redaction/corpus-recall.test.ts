import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CaseOutcome,
  buildFullStack,
  corpusConfig,
  isCaught,
  loadCorpus,
  normalizeValue,
  runStack,
} from './_corpus.js';
import { hasNerModel } from './_ner.js';

/**
 * The Task 4.1 CI recall gate. Runs the REAL full stack (vendored NER model +
 * regex + deny-list) over the labeled synthetic corpus and enforces:
 *  - per-entity-type and overall recall >= REDACTION_RECALL_TARGET, failing with
 *    a message that names REDACTION_RECALL_REGRESSION;
 *  - no-egress: every case that would CONTINUE has an output containing none of
 *    the corpus PII values;
 *  - expectHold cases (e.g. spelled-out digit phones) actually hold.
 * The ci-guard test makes this suite mandatory under CI (never silently skips).
 */
const SUITE_TIMEOUT = 300_000;

describe.skipIf(!hasNerModel)('redaction corpus recall gate', () => {
  const corpus = loadCorpus('corpus.json');
  const { recallTarget, riskThreshold } = corpusConfig();
  const outcomes = new Map<string, CaseOutcome>();

  beforeAll(async () => {
    const detectors = buildFullStack(corpus.denyTerms);
    for (const c of corpus.cases) {
      outcomes.set(c.id, await runStack(detectors, corpus.denyTerms, c.text, riskThreshold));
    }
  }, SUITE_TIMEOUT);

  it('meets the recall target per entity type and overall', () => {
    const perType = new Map<string, { total: number; caught: number }>();
    let total = 0;
    let caught = 0;
    const misses: string[] = [];

    for (const c of corpus.cases) {
      const outcome = outcomes.get(c.id)!;
      for (const entity of c.entities) {
        const bucket = perType.get(entity.type) ?? { total: 0, caught: 0 };
        bucket.total += 1;
        total += 1;
        if (isCaught(outcome, entity.value)) {
          bucket.caught += 1;
          caught += 1;
        } else {
          misses.push(`${c.id} [${entity.type}]`);
        }
        perType.set(entity.type, bucket);
      }
    }

    const failures: string[] = [];
    for (const [type, { total: t, caught: cg }] of perType) {
      const recall = cg / t;
      if (recall < recallTarget) {
        failures.push(`${type}: ${String(cg)}/${String(t)} = ${recall.toFixed(3)}`);
      }
    }
    const overall = caught / total;
    if (overall < recallTarget) {
      failures.push(`overall: ${String(caught)}/${String(total)} = ${overall.toFixed(3)}`);
    }

    expect(
      failures,
      `REDACTION_RECALL_REGRESSION: corpus recall below target ${String(recallTarget)} — ` +
        `${failures.join('; ')} — missed: ${misses.join(', ')}`,
    ).toEqual([]);
  });

  it('no-egress: every continuing case has an output free of ALL corpus PII values', () => {
    const allValues = corpus.cases.flatMap((c) => c.entities.map((e) => e.value));
    for (const c of corpus.cases) {
      const outcome = outcomes.get(c.id)!;
      if (outcome.held) continue;
      const output = normalizeValue(outcome.redactedText);
      for (const value of allValues) {
        expect(
          output.includes(normalizeValue(value)),
          `case ${c.id} would egress "${value.slice(0, 3)}…" (value redacted in this message)`,
        ).toBe(false);
      }
    }
  });

  it('expectHold cases (spelled-out digits, ...) are held, never passed', () => {
    for (const c of corpus.cases.filter((x) => x.expectHold)) {
      const outcome = outcomes.get(c.id)!;
      expect(outcome.held, `${c.id} should hold (reasons: ${outcome.reasons.join(',')})`).toBe(
        true,
      );
    }
  });

  it('clean cases pass without holding (sanity: the gate is not hold-everything)', () => {
    for (const c of corpus.cases.filter((x) => x.id.startsWith('clean-'))) {
      const outcome = outcomes.get(c.id)!;
      expect(outcome.held, `${c.id} unexpectedly held: ${outcome.reasons.join(',')}`).toBe(false);
    }
  });
});
