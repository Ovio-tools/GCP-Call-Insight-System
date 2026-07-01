import { z } from 'zod';
import { severitySchema } from '../enums.js';
import { jsonValueSchema } from '../types.js';

/** alert_events — emitted alerts with dedup key + sanitized snapshot. PK: id. */
export const alertEventRowSchema = z.object({
  id: z.string().uuid(),
  error_code: z.string(),
  root_cause_category: z.string(),
  severity: severitySchema,
  dedup_key: z.string(),
  acknowledged_at: z.date().nullable(),
  created_at: z.date(),
  failure_snapshot: jsonValueSchema,
});
export type AlertEventRow = z.infer<typeof alertEventRowSchema>;

export const alertEventInsertSchema = z.object({
  errorCode: z.string().min(1),
  rootCauseCategory: z.string().min(1),
  severity: severitySchema,
  dedupKey: z.string().min(1),
  failureSnapshot: jsonValueSchema.optional(),
});
export type AlertEventInsert = z.infer<typeof alertEventInsertSchema>;
