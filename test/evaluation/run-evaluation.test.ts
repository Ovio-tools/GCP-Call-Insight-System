import { describe, expect, it } from 'vitest';
import type { LabeledExampleRow } from '../../src/db/schemas/labeled-examples.js';
import {
  runEvaluation,
  type ClassifyPredictor,
  type ExtractPredictor,
} from '../../src/evaluation/run-evaluation.js';
import { EVALUATION_FAILURE_SAMPLE_LIMIT } from '../../src/evaluation/version.js';

const NOW = new Date('2026-07-05T06:00:00.000Z');

function classifyExample(id: string, bucket: string, text = 'redacted body'): LabeledExampleRow {
  return {
    id,
    operator_action_id: '00000000-0000-0000-0000-000000000000',
    task_type: 'classify',
    review_queue_id: '00000000-0000-0000-0000-000000000000',
    call_id: `c-${id}`,
    held_reason: 'classified_spam',
    reviewer_actor: 'r',
    redacted_input: text,
    expected_output: { bucket },
    source_prompt_version: 'classify-v1',
    prompt_version_source: 'current_constant',
    source_schema_version: null,
    model_id: 'haiku',
    model_id_source: 'model_invocations',
    eval_set_version: 1,
    pii_gate_version: 1,
    created_at: NOW,
  } as LabeledExampleRow;
}

function extractExample(id: string, enums: Record<string, string>): LabeledExampleRow {
  return {
    ...classifyExample(id, 'x'),
    task_type: 'extract',
    held_reason: 'schema_invalid',
    expected_output: enums,
    source_prompt_version: 'extract-v1',
    source_schema_version: 1,
  } as unknown as LabeledExampleRow;
}

const NOOP_EXTRACT: ExtractPredictor = () => Promise.resolve({ status: 'error' as const });
const NOOP_CLASSIFY: ClassifyPredictor = () => Promise.resolve({ status: 'error' as const });

describe('runEvaluation', () => {
  it('reports classify bucket accuracy', async () => {
    const examples = [
      classifyExample('a', 'spam'),
      classifyExample('b', 'customer'),
      classifyExample('c', 'spam'),
    ];
    const classify: ClassifyPredictor = (ex) =>
      Promise.resolve({
        status: 'ok',
        value: {
          bucket: ex.id === 'c' ? 'customer' : (ex.expected_output as { bucket: string }).bucket,
        },
      });
    const report = await runEvaluation({
      examples,
      classifyPredictor: classify,
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    expect(report.status).toBe('complete');
    expect(report.examples_evaluated).toBe(3);
    expect(report.byTaskType.classify?.metric).toBe('classify_bucket_accuracy');
    expect(report.byTaskType.classify?.correct).toBe(2);
    expect(report.byTaskType.classify?.incorrect).toBe(1);
    // The one mismatch is a bounded failure entry (enum/bucket values only).
    const fail = report.failures.find((f) => f.labeled_example_id === 'c')!;
    expect(fail.failure_category).toBe('mismatch');
    expect(fail.expected).toBe('spam');
    expect(fail.predicted).toBe('customer');
  });

  it('reports extract controlled-field accuracy with coverage metadata', async () => {
    const enums = {
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'urgent',
      sentiment: 'frustrated',
    };
    const examples = [extractExample('e1', enums), extractExample('e2', enums)];
    const extract: ExtractPredictor = (ex) =>
      Promise.resolve({
        status: 'ok',
        // e2 gets urgency wrong.
        value: ex.id === 'e2' ? { ...enums, urgency: 'routine' } : { ...enums },
      });
    const report = await runEvaluation({
      examples,
      classifyPredictor: NOOP_CLASSIFY,
      extractPredictor: extract,
      now: NOW,
    });
    const ex = report.byTaskType.extract!;
    expect(ex.metric).toBe('extract_controlled_field_accuracy');
    expect(ex.fields_evaluated).toEqual([
      'call_intent',
      'service_category',
      'urgency',
      'sentiment',
    ]);
    expect(ex.fields_not_evaluated.length).toBe(9);
    expect(ex.label_source).toBe('correct_extraction');
    // Example-level: e1 all-correct, e2 not (urgency wrong).
    expect(ex.correct).toBe(1);
    expect(ex.per_field.urgency.correct).toBe(1);
    expect(ex.per_field.call_intent.correct).toBe(2);
  });

  it('never labels the extract metric as full extraction accuracy and omits transcript text', async () => {
    const report = await runEvaluation({
      examples: [classifyExample('a', 'spam', 'SECRET-REDACTED-BODY')],
      classifyPredictor: (ex) =>
        Promise.resolve({
          status: 'ok',
          value: { bucket: (ex.expected_output as { bucket: string }).bucket },
        }),
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET-REDACTED-BODY');
    expect(serialized).not.toContain('full extraction accuracy');
  });

  it('marks a mid-run cost cap partial and counts the rest as skipped', async () => {
    const examples = [
      classifyExample('a', 'spam'),
      classifyExample('b', 'spam'),
      classifyExample('c', 'spam'),
    ];
    let calls = 0;
    const classify: ClassifyPredictor = (ex) => {
      calls += 1;
      if (calls >= 2) return Promise.resolve({ status: 'cost_capped' as const });
      return Promise.resolve({
        status: 'ok',
        value: { bucket: (ex.expected_output as { bucket: string }).bucket },
      });
    };
    const report = await runEvaluation({
      examples,
      classifyPredictor: classify,
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    expect(report.status).toBe('partial');
    expect(report.skip_reason).toBe('cost_capped');
    expect(report.examples_evaluated).toBe(1);
    expect(report.examples_skipped).toBe(2);
  });

  it('marks a run skipped when the cap trips before any example is evaluated', async () => {
    const report = await runEvaluation({
      examples: [classifyExample('a', 'spam')],
      classifyPredictor: () => Promise.resolve({ status: 'killed' as const }),
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    expect(report.status).toBe('skipped');
    expect(report.skip_reason).toBe('killed');
    expect(report.examples_evaluated).toBe(0);
  });

  it('marks an empty corpus skipped with no_examples', async () => {
    const report = await runEvaluation({
      examples: [],
      classifyPredictor: NOOP_CLASSIFY,
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    expect(report.status).toBe('skipped');
    expect(report.skip_reason).toBe('no_examples');
  });

  it('bounds the failures sample and keeps aggregate counts in the summary', async () => {
    const n = EVALUATION_FAILURE_SAMPLE_LIMIT + 15;
    const examples = Array.from({ length: n }, (_, i) => classifyExample(`m${i}`, 'spam'));
    const classify: ClassifyPredictor = () =>
      Promise.resolve({ status: 'ok', value: { bucket: 'customer' } }); // always mismatch
    const report = await runEvaluation({
      examples,
      classifyPredictor: classify,
      extractPredictor: NOOP_EXTRACT,
      now: NOW,
    });
    expect(report.failures.length).toBe(EVALUATION_FAILURE_SAMPLE_LIMIT);
    expect(report.byTaskType.classify?.incorrect).toBe(n);
    expect(report.examples_evaluated).toBe(n);
  });
});
