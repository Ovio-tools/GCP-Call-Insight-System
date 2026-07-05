import { z } from 'zod';
import { reprocessRequestStatusSchema } from '../enums.js';

/**
 * reprocess_requests — the durable outbox for a reprocess/approve/correct_extraction review
 * action (Task 6.2). One row per audited action (UNIQUE `operator_action_id`), written in the
 * state-change transaction and drained by the reconciliation cron. PK: id.
 */
export const reprocessRequestRowSchema = z.object({
  id: z.string().uuid(),
  operator_action_id: z.string().uuid(),
  call_id: z.string(),
  review_queue_id: z.string().uuid(),
  target_stage: z.string(),
  requested_by: z.string(),
  status: reprocessRequestStatusSchema,
  prior_stage: z.string().nullable(),
  prior_status: z.string().nullable(),
  prior_drop_reason: z.string().nullable(),
  attempt_count: z.number().int(),
  last_error_code: z.string().nullable(),
  last_attempted_at: z.date().nullable(),
  created_at: z.date(),
  sent_at: z.date().nullable(),
});
export type ReprocessRequestRow = z.infer<typeof reprocessRequestRowSchema>;

/** Insert input (camelCase). The `prior_*` columns capture the pre-transition call_state for
 * operator rollback / drain diagnostics. */
export const insertReprocessRequestSchema = z.object({
  operatorActionId: z.string().uuid(),
  callId: z.string().min(1),
  reviewQueueId: z.string().uuid(),
  targetStage: z.string().min(1),
  requestedBy: z.string().min(1),
  priorStage: z.string().nullable().optional(),
  priorStatus: z.string().nullable().optional(),
  priorDropReason: z.string().nullable().optional(),
});
export type InsertReprocessRequestInput = z.infer<typeof insertReprocessRequestSchema>;
