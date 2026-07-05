import { z } from 'zod';
import { EVALUATION_FAILURE_SAMPLE_LIMIT } from '../../evaluation/version.js';
import { expectedExtractOutputSchema, labeledTaskTypeSchema } from './labeled-examples.js';

/**
 * The four wire classify buckets a PREDICTION may take (a label's ground truth is only the three in
 * `LABEL_CLASSIFY_BUCKETS`, but the model can predict `held`). Kept as a local literal so this DB
 * schema does not drag in the Anthropic SDK via `anthropic/client`'s `CLASSIFY_BUCKETS`, which is
 * the source of truth — the classify parse cross-check test pins that tuple.
 */
const PREDICTED_CLASSIFY_BUCKETS = ['customer', 'non-customer', 'spam', 'held'] as const;

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

/**
 * A single failure entry's `expected`/`predicted` value — CONTROLLED values only, never free text:
 * a classify bucket (all four wire buckets — `predicted` may be `held` even though a label's
 * `expected` never is), the strict four-enum extract record, or `null` (a prediction error / a
 * cost-capped / killed stop). This is the structural guard that keeps transcript-like text out of
 * the report.
 */
export const enumValueSchema = z
  .union([z.enum(PREDICTED_CLASSIFY_BUCKETS), expectedExtractOutputSchema])
  .nullable();

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

/** Grouped counts only — the strict shape `runEvaluation` produces. No free text can ride in. */
const nonNegInt = z.number().int().nonnegative();
const accuracySchema = z.number().min(0).max(1);
const fieldTallySchema = z
  .object({ total: nonNegInt, correct: nonNegInt, accuracy: accuracySchema })
  .strict();
const classifyMetricSchema = z
  .object({
    metric: z.literal('classify_bucket_accuracy'),
    total: nonNegInt,
    correct: nonNegInt,
    incorrect: nonNegInt,
    accuracy: accuracySchema,
  })
  .strict();
const extractMetricSchema = z
  .object({
    metric: z.literal('extract_controlled_field_accuracy'),
    total: nonNegInt,
    correct: nonNegInt,
    incorrect: nonNegInt,
    accuracy: accuracySchema,
    per_field: z
      .object({
        call_intent: fieldTallySchema,
        service_category: fieldTallySchema,
        urgency: fieldTallySchema,
        sentiment: fieldTallySchema,
      })
      .strict(),
    fields_evaluated: z.array(z.string()),
    fields_not_evaluated: z.array(z.string()),
    label_source: z.literal('correct_extraction'),
  })
  .strict();
const groupTallySchema = z
  .object({
    task_type: labeledTaskTypeSchema,
    prompt_version: z.string(),
    model_id: z.string().nullable(),
    eval_set_version: z.number().int(),
    total: nonNegInt,
    correct: nonNegInt,
    incorrect: nonNegInt,
    accuracy: accuracySchema,
  })
  .strict();
export const evaluationSummarySchema = z
  .object({
    byTaskType: z
      .object({
        classify: classifyMetricSchema.optional(),
        extract: extractMetricSchema.optional(),
      })
      .strict(),
    byGroup: z.array(groupTallySchema),
  })
  .strict();
export type EvaluationSummary = z.infer<typeof evaluationSummarySchema>;

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
  summary: evaluationSummarySchema,
  failures: z.array(evaluationFailureSampleSchema).max(EVALUATION_FAILURE_SAMPLE_LIMIT),
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
    summary: evaluationSummarySchema,
    failures: z.array(evaluationFailureSampleSchema).max(EVALUATION_FAILURE_SAMPLE_LIMIT),
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
