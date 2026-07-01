import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** call_state — the per-call spine. Durable, never purged. PK: call_id. */
export const callStateRowSchema = z.object({
  call_id: z.string(),
  source: z.string(),
  source_metadata: jsonValueSchema,
  current_stage: z.string(),
  status: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type CallStateRow = z.infer<typeof callStateRowSchema>;

export const callStateInsertSchema = z.object({
  callId: z.string().min(1),
  source: z.string().min(1),
  sourceMetadata: jsonValueSchema.optional(),
  currentStage: z.string().min(1),
  status: z.string().min(1),
});
export type CallStateInsert = z.infer<typeof callStateInsertSchema>;
