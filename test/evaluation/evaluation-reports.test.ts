import { describe, expect, it } from 'vitest';
import { insertEvaluationReportSchema } from '../../src/db/schemas/evaluation-reports.js';

/**
 * The evaluation_reports insert schema mirrors the DB status × skip_reason cross-field CHECK
 * (finding R4-2), so an inconsistent report is rejected at the zod boundary too.
 */
const base = {
  evalSetVersion: 1,
  piiGateVersion: 1,
  mode: 'live' as const,
  generatedAt: new Date('2026-07-05T00:00:00.000Z'),
  summary: {},
  failures: [],
  examplesEvaluated: 0,
  examplesSkipped: 0,
};

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
