import { z } from 'zod';
import { severitySchema } from '../enums.js';
import { jsonValueSchema } from '../types.js';

/**
 * Alert delivery state (Task 7.3). Kept byte-for-byte aligned with the `alert_events`
 * CHECK constraint in migration 1782864000011 so an invalid state can be written from no
 * path — neither raw SQL (the DB check rejects it) nor the DAL (this zod enum rejects it).
 */
export const DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const;
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/** alert_events — emitted alerts with dedup key + sanitized snapshot + durable delivery
 * state (Task 7.3). PK: id. */
export const alertEventRowSchema = z.object({
  id: z.string().uuid(),
  error_code: z.string(),
  root_cause_category: z.string(),
  severity: severitySchema,
  dedup_key: z.string(),
  acknowledged_at: z.date().nullable(),
  created_at: z.date(),
  failure_snapshot: jsonValueSchema,
  // Durable delivery obligation (Task 7.3). Defaults are set at insert, so every row is a
  // retryable obligation from the moment it exists.
  delivery_state: deliveryStateSchema,
  delivery_attempts: z.number().int().nonnegative(),
  next_attempt_at: z.date(),
  delivered_at: z.date().nullable(),
  last_delivery_error: z.string().nullable(),
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
