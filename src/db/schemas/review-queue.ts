import { z } from 'zod';
import { heldReasonSchema, reviewStatusSchema } from '../enums.js';

/** review_queue — held calls awaiting a person. PK: id. */
export const reviewQueueRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string(),
  held_reason: heldReasonSchema,
  status: reviewStatusSchema,
  assignee: z.string().nullable(),
  sla_due_at: z.date().nullable(),
  escalated_at: z.date().nullable(),
  raw_purged_at: z.date().nullable(),
  created_at: z.date(),
  resolved_at: z.date().nullable(),
});
export type ReviewQueueRow = z.infer<typeof reviewQueueRowSchema>;

export const enqueueReviewInputSchema = z.object({
  callId: z.string().min(1),
  heldReason: heldReasonSchema,
  slaDueAt: z.date(),
  assignee: z.string().nullable().optional(),
});
export type EnqueueReviewInput = z.infer<typeof enqueueReviewInputSchema>;
