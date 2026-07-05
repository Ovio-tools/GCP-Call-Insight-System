import { describe, expect, it } from 'vitest';
import { insertEvaluationReportSchema } from '../../src/db/schemas/evaluation-reports.js';
import { EVALUATION_FAILURE_SAMPLE_LIMIT } from '../../src/evaluation/version.js';

/**
 * The evaluation_reports insert schema mirrors the DB status × skip_reason cross-field CHECK
 * (finding R4-2) AND enforces the PII-free boundary: `summary` is a strict grouped-counts shape and
 * failure `expected`/`predicted` are controlled values only, so no transcript-like free text can be
 * persisted through the repository (finding P2/3).
 */
const base = {
  evalSetVersion: 1,
  piiGateVersion: 1,
  mode: 'live' as const,
  generatedAt: new Date('2026-07-05T00:00:00.000Z'),
  summary: { byTaskType: {}, byGroup: [] },
  failures: [],
  examplesEvaluated: 0,
  examplesSkipped: 0,
};

const UUID = '00000000-0000-0000-0000-0000000000aa';

describe('insertEvaluationReportSchema status × skip_reason refinement', () => {
  it('accepts the valid combinations', () => {
    expect(
      insertEvaluationReportSchema.safeParse({ ...base, status: 'complete', skipReason: 'none' })
        .success,
    ).toBe(true);
    expect(
      insertEvaluationReportSchema.safeParse({
        ...base,
        status: 'partial',
        skipReason: 'cost_capped',
      }).success,
    ).toBe(true);
    expect(
      insertEvaluationReportSchema.safeParse({ ...base, status: 'partial', skipReason: 'killed' })
        .success,
    ).toBe(true);
    expect(
      insertEvaluationReportSchema.safeParse({
        ...base,
        status: 'skipped',
        skipReason: 'no_examples',
      }).success,
    ).toBe(true);
  });

  it('rejects the inconsistent combinations', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...base,
        status: 'complete',
        skipReason: 'cost_capped',
      }).success,
    ).toBe(false);
    expect(
      insertEvaluationReportSchema.safeParse({ ...base, status: 'skipped', skipReason: 'none' })
        .success,
    ).toBe(false);
    expect(
      insertEvaluationReportSchema.safeParse({
        ...base,
        status: 'partial',
        skipReason: 'no_examples',
      }).success,
    ).toBe(false);
  });

  it('rejects a dry_run mode (never a persisted value)', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...base,
        mode: 'dry_run',
        status: 'complete',
        skipReason: 'none',
      }).success,
    ).toBe(false);
  });
});

describe('insertEvaluationReportSchema PII-free boundary', () => {
  const valid = { ...base, status: 'complete' as const, skipReason: 'none' as const };

  it('rejects a free-text summary', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...valid,
        summary: { note: 'the caller said their address was ...' },
      }).success,
    ).toBe(false);
  });

  it('rejects a free-text failure expected/predicted value', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...valid,
        failures: [
          {
            labeled_example_id: UUID,
            task_type: 'classify',
            expected: 'a whole redacted transcript',
            predicted: 'customer',
            failure_category: 'mismatch',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a controlled bucket failure (predicted may be held)', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...valid,
        failures: [
          {
            labeled_example_id: UUID,
            task_type: 'classify',
            expected: 'spam',
            predicted: 'held',
            failure_category: 'mismatch',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed extract record in a failure', () => {
    expect(
      insertEvaluationReportSchema.safeParse({
        ...valid,
        failures: [
          {
            labeled_example_id: UUID,
            task_type: 'extract',
            expected: {
              call_intent: 'general',
              service_category: 'other',
              urgency: 'nope',
              sentiment: 'neutral',
            },
            predicted: null,
            failure_category: 'mismatch',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects an oversized failures array', () => {
    const one = {
      labeled_example_id: UUID,
      task_type: 'classify' as const,
      expected: 'spam',
      predicted: 'customer',
      failure_category: 'mismatch' as const,
    };
    expect(
      insertEvaluationReportSchema.safeParse({
        ...valid,
        failures: Array.from({ length: EVALUATION_FAILURE_SAMPLE_LIMIT + 1 }, () => one),
      }).success,
    ).toBe(false);
  });
});
