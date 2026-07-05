import { z } from 'zod';
import { jsonValueSchema } from '../types.js';
import { labeledTaskTypeSchema } from './labeled-examples.js';

/**
 * evaluation_reports — the PII-free durable destination for a periodic accuracy check (Task 6.3).
 * `mode='live'` is the only authoritative accuracy signal; `test_stub` is non-authoritative;
 * `dry_run` is a CLI preview that persists NOTHING (never a value here). `summary` is grouped counts
 * only and `failures` is a bounded sample of ids/enums/failure-category only — no transcript, no
 * free text. A privacy test serializes the whole inserted row and asserts no content fields appear.
 */

export const evaluationModeSchema = z.enum(['live', 'test_stub']);
export type EvaluationMode = z.infer<typeof evaluationModeSchema>;

export const evaluationStatusSchema = z.enum(['complete', 'partial', 'skipped']);
export type EvaluationStatus = z.infer<typeof evaluationStatusSchema>;

export const evaluationSkipReasonSchema = z.enum(['cost_capped', 'killed', 'no_examples', 'none']);
export type EvaluationSkipReason = z.infer<typeof evaluationSkipReasonSchema>;

/** Why a single example counted as a failure. All values are closed-vocabulary, never free text. */
export const failureCategorySchema = z.enum([
  'mismatch',
  'model_malformed',
  'prediction_error',
  'cost_capped',
  'killed',
]);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

/** A bucket string or the 4-enum record — controlled values only, or null on a prediction error. */
export const enumValueSchema = z.union([z.string(), z.record(z.string())]).nullable();

/** One bounded failure-sample entry — ids/enums/failure-category only. */
export const evaluationFailureSampleSchema = z
  .object({
    labeled_example_id: z.string().uuid(),
    task_type: labeledTaskTypeSchema,
    expected: enumValueSchema,
    predicted: enumValueSchema,
    failure_category: failureCategorySchema,
  })
  .strict();
export type EvaluationFailureSample = z.infer<typeof evaluationFailureSampleSchema>;

/** The status × skip_reason completeness invariant (mirrors the DB CHECK, finding R4-2). */
function statusSkipConsistent(status: EvaluationStatus, skip: EvaluationSkipReason): boolean {
  if (status === 'complete') return skip === 'none';
  if (status === 'partial') return skip === 'cost_capped' || skip === 'killed';
  // skipped
  return skip === 'cost_capped' || skip === 'killed' || skip === 'no_examples';
}

export const evaluationReportRowSchema = z.object({
  id: z.string().uuid(),
  eval_set_version: z.number().int(),
  pii_gate_version: z.number().int(),
  mode: evaluationModeSchema,
  status: evaluationStatusSchema,
  skip_reason: evaluationSkipReasonSchema,
  generated_at: z.date(),
  summary: jsonValueSchema,
  failures: z.array(jsonValueSchema),
  examples_evaluated: z.number().int(),
  examples_skipped: z.number().int(),
  created_at: z.date(),
});
export type EvaluationReportRow = z.infer<typeof evaluationReportRowSchema>;

export const insertEvaluationReportSchema = z
  .object({
    evalSetVersion: z.number().int(),
    piiGateVersion: z.number().int(),
    mode: evaluationModeSchema,
    status: evaluationStatusSchema,
    skipReason: evaluationSkipReasonSchema,
    generatedAt: z.date(),
    summary: jsonValueSchema,
    failures: z.array(evaluationFailureSampleSchema),
    examplesEvaluated: z.number().int().nonnegative(),
    examplesSkipped: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    if (!statusSkipConsistent(v.status, v.skipReason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skipReason'],
        message: `status '${v.status}' is inconsistent with skip_reason '${v.skipReason}'`,
      });
    }
  });
export type InsertEvaluationReportInput = z.infer<typeof insertEvaluationReportSchema>;
