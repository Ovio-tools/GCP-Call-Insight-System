import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** processing_log — per-stage audit trail. call_id unconstrained so a log write never
 * fails on a missing FK. PK: id. Append-only. */
export const processingLogRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string().nullable(),
  stage: z.string(),
  outcome: z.string(),
  error_code: z.string().nullable(),
  detail: jsonValueSchema.nullable(),
  created_at: z.date(),
  failure_snapshot: jsonValueSchema.nullable(),
});
export type ProcessingLogRow = z.infer<typeof processingLogRowSchema>;

export const processingLogInsertSchema = z.object({
  callId: z.string().nullable().optional(),
  stage: z.string().min(1),
  outcome: z.string().min(1),
  errorCode: z.string().nullable().optional(),
  detail: jsonValueSchema.nullable().optional(),
  failureSnapshot: jsonValueSchema.nullable().optional(),
});
export type ProcessingLogInsert = z.infer<typeof processingLogInsertSchema>;
