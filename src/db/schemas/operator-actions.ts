import { z } from 'zod';
import { operatorActionSchema } from '../enums.js';
import { jsonValueSchema } from '../types.js';

/** operator_actions — audit trail of review-surface actions. PK: id. */
export const operatorActionRowSchema = z.object({
  id: z.string().uuid(),
  review_queue_id: z.string().uuid(),
  actor: z.string(),
  action: operatorActionSchema,
  before: jsonValueSchema.nullable(),
  after: jsonValueSchema.nullable(),
  created_at: z.date(),
});
export type OperatorActionRow = z.infer<typeof operatorActionRowSchema>;

export const recordOperatorActionInputSchema = z.object({
  reviewQueueId: z.string().uuid(),
  actor: z.string().min(1),
  action: operatorActionSchema,
  before: jsonValueSchema.nullable(),
  after: jsonValueSchema.nullable(),
});
export type RecordOperatorActionInput = z.infer<typeof recordOperatorActionInputSchema>;
