import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** call_state — the per-call spine. Durable, never purged. PK: call_id. */
export const callStateRowSchema = z.object({
  call_id: z.string(),
  source: z.string(),
  source_metadata: jsonValueSchema,
  current_stage: z.string(),
  status: z.string(),
  drop_reason: z.string().nullable(),
  /** When fetch-transcript first saw a not-ready transcript; bounds the retry window
   * before the call is held with missing_transcript (Task 3.3). Null until then. */
  transcript_wait_started_at: z.date().nullable(),
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
