import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** dead_letter — jobs that exhausted retries, with sanitized root-cause metadata. PK: id. */
export const deadLetterRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string().nullable(),
  job_payload: jsonValueSchema,
  error_code: z.string(),
  root_cause_category: z.string(),
  last_error: z.string().nullable(),
  failed_at: z.date(),
  failure_snapshot: jsonValueSchema,
});
export type DeadLetterRow = z.infer<typeof deadLetterRowSchema>;

export const deadLetterInsertSchema = z.object({
  callId: z.string().nullable().optional(),
  jobPayload: jsonValueSchema.optional(),
  errorCode: z.string().min(1),
  rootCauseCategory: z.string().min(1),
  lastError: z.string().nullable().optional(),
  failureSnapshot: jsonValueSchema.optional(),
});
export type DeadLetterInsert = z.infer<typeof deadLetterInsertSchema>;
