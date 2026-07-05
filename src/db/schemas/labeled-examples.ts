import { z } from 'zod';
import { CLASSIFY_BUCKETS } from '../../anthropic/client.js';
import {
  callIntentSchema,
  heldReasonSchema,
  sentimentSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../enums.js';

/**
 * labeled_examples — ACCEPTED labels mined from resolved review decisions (Task 6.3). Redacted
 * input + corrected controlled-enum output + sanitized provenance. NEVER raw transcript text, vault
 * values, or clear PII. PK: id; version-scoped UNIQUE on
 * `(operator_action_id, task_type, pii_gate_version, eval_set_version)`.
 */

export const labeledTaskTypeSchema = z.enum(['classify', 'extract']);
export type LabeledTaskType = z.infer<typeof labeledTaskTypeSchema>;

export const promptVersionSourceSchema = z.enum(['model_invocations', 'current_constant', 'none']);
export const modelIdSourceSchema = z.enum(['model_invocations', 'none']);

/** A classify label's expected output — the reviewer-derived bucket only. */
export const expectedClassifyOutputSchema = z.object({ bucket: z.enum(CLASSIFY_BUCKETS) }).strict();
/** An extract label's expected output — the four reviewer-correctable controlled enums only. */
export const expectedExtractOutputSchema = z
  .object({
    call_intent: callIntentSchema,
    service_category: serviceCategorySchema,
    urgency: urgencySchema,
    sentiment: sentimentSchema,
  })
  .strict();
/** `{bucket}` (classify) | 4-enum record (extract). No free text, controlled values only. */
export const expectedOutputSchema = z.union([
  expectedClassifyOutputSchema,
  expectedExtractOutputSchema,
]);
export type ExpectedClassifyOutput = z.infer<typeof expectedClassifyOutputSchema>;
export type ExpectedExtractOutput = z.infer<typeof expectedExtractOutputSchema>;
export type ExpectedOutput = z.infer<typeof expectedOutputSchema>;

export const labeledExampleRowSchema = z.object({
  id: z.string().uuid(),
  operator_action_id: z.string().uuid(),
  task_type: labeledTaskTypeSchema,
  review_queue_id: z.string().uuid(),
  call_id: z.string(),
  held_reason: heldReasonSchema,
  reviewer_actor: z.string(),
  redacted_input: z.string(),
  expected_output: expectedOutputSchema,
  source_prompt_version: z.string(),
  prompt_version_source: promptVersionSourceSchema,
  source_schema_version: z.number().int().nullable(),
  model_id: z.string().nullable(),
  model_id_source: modelIdSourceSchema,
  eval_set_version: z.number().int(),
  pii_gate_version: z.number().int(),
  created_at: z.date(),
});
export type LabeledExampleRow = z.infer<typeof labeledExampleRowSchema>;

export const insertLabeledExampleSchema = z.object({
  operatorActionId: z.string().uuid(),
  taskType: labeledTaskTypeSchema,
  reviewQueueId: z.string().uuid(),
  callId: z.string().min(1),
  heldReason: heldReasonSchema,
  reviewerActor: z.string().min(1),
  redactedInput: z.string(),
  expectedOutput: expectedOutputSchema,
  sourcePromptVersion: z.string().min(1),
  promptVersionSource: promptVersionSourceSchema,
  sourceSchemaVersion: z.number().int().nullable().optional(),
  modelId: z.string().nullable().optional(),
  modelIdSource: modelIdSourceSchema,
  evalSetVersion: z.number().int(),
  piiGateVersion: z.number().int(),
});
export type InsertLabeledExampleInput = z.infer<typeof insertLabeledExampleSchema>;
