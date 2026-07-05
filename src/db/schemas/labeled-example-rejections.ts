import { z } from 'zod';
import { heldReasonSchema } from '../enums.js';
import { labeledTaskTypeSchema } from './labeled-examples.js';

/**
 * labeled_example_rejections — CONTENT-FREE failed label validations (Task 6.3). A row records that
 * a resolved decision could not become an accepted label because of a residual-PII gate hit
 * (`pii`), an extract schema failure (`schema`), or a purged/absent clean transcript
 * (`missing_clean`). NO content columns: `rejection_counts` is the closed-vocabulary residual-scan
 * category→count map, present ONLY for a `pii` rejection and NULL otherwise. Version-scoped UNIQUE
 * on `(operator_action_id, task_type, pii_gate_version, eval_set_version)` so a gate/set bump
 * re-opens a previously rejected candidate without duplicating identical repeat attempts.
 */

export const rejectionReasonSchema = z.enum(['pii', 'schema', 'missing_clean']);
export type RejectionReason = z.infer<typeof rejectionReasonSchema>;

export const labeledExampleRejectionRowSchema = z.object({
  id: z.string().uuid(),
  operator_action_id: z.string().uuid(),
  task_type: labeledTaskTypeSchema,
  review_queue_id: z.string().uuid(),
  call_id: z.string(),
  held_reason: heldReasonSchema,
  rejection_reason: rejectionReasonSchema,
  rejection_counts: z.record(z.number()).nullable(),
  eval_set_version: z.number().int(),
  pii_gate_version: z.number().int(),
  created_at: z.date(),
});
export type LabeledExampleRejectionRow = z.infer<typeof labeledExampleRejectionRowSchema>;

/**
 * Insert input. The counts-shape invariant (present iff `pii`) is enforced by the DB CHECK and by
 * this refinement, so a caller can never write a `pii` row without counts or a content-free row
 * with them.
 */
export const insertRejectionSchema = z
  .object({
    operatorActionId: z.string().uuid(),
    taskType: labeledTaskTypeSchema,
    reviewQueueId: z.string().uuid(),
    callId: z.string().min(1),
    heldReason: heldReasonSchema,
    rejectionReason: rejectionReasonSchema,
    rejectionCounts: z.record(z.number()).nullable(),
    evalSetVersion: z.number().int(),
    piiGateVersion: z.number().int(),
  })
  .superRefine((v, ctx) => {
    if (v.rejectionReason === 'pii' && v.rejectionCounts === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionCounts'],
        message: "a 'pii' rejection must carry residual-scan counts",
      });
    }
    if (v.rejectionReason !== 'pii' && v.rejectionCounts !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionCounts'],
        message: `a '${v.rejectionReason}' rejection is content-free and must not carry counts`,
      });
    }
  });
export type InsertRejectionInput = z.infer<typeof insertRejectionSchema>;
