import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/**
 * component_heartbeats — the in-DB mirror of the external per-component dead-man's-switch
 * pings (Task 7.3). One row per component, upserted on each successful periodic tick. Feeds
 * the status surface only; the external monitor stays the authoritative alarm.
 */

/** Coarse health a writer reports for a tick. Not a pg enum (small, status-layer-owned). */
export const HEARTBEAT_STATUSES = ['ok', 'degraded'] as const;
export const heartbeatStatusSchema = z.enum(HEARTBEAT_STATUSES);
export type HeartbeatStatus = z.infer<typeof heartbeatStatusSchema>;

export const componentHeartbeatRowSchema = z.object({
  component: z.string(),
  last_run_at: z.date(),
  // Constrained to the same vocabulary as the DB CHECK (migration 1782864000010): an invalid
  // stored status (bad manual/future write) fails the read parse rather than being silently
  // treated as healthy by the status aggregator.
  last_status: heartbeatStatusSchema,
  detail: jsonValueSchema,
  updated_at: z.date(),
});
export type ComponentHeartbeatRow = z.infer<typeof componentHeartbeatRowSchema>;

export const recordHeartbeatInputSchema = z.object({
  component: z.string().min(1),
  status: heartbeatStatusSchema.default('ok'),
  /** Counts-only, PII-free detail. The repo content-field-guards this before insert. */
  detail: z.record(z.string(), jsonValueSchema).optional(),
});
export type RecordHeartbeatInput = z.input<typeof recordHeartbeatInputSchema>;
