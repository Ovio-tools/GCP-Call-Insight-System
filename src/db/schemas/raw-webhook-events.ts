import { z } from 'zod';
import { signatureStatusSchema } from '../enums.js';
import { jsonValueSchema } from '../types.js';

/** raw_webhook_events — allowlisted metadata only; phone/name hashed. Purgeable. PK: id. */
export const rawWebhookEventRowSchema = z.object({
  id: z.string().uuid(),
  received_at: z.date(),
  source: z.string(),
  payload: jsonValueSchema,
  signature_status: signatureStatusSchema,
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type RawWebhookEventRow = z.infer<typeof rawWebhookEventRowSchema>;

export const rawWebhookEventInsertSchema = z.object({
  source: z.string().min(1),
  payload: jsonValueSchema.optional(),
  signatureStatus: signatureStatusSchema,
});
export type RawWebhookEventInsert = z.infer<typeof rawWebhookEventInsertSchema>;
