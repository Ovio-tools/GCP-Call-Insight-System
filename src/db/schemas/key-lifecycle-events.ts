import { z } from 'zod';

/**
 * key_lifecycle_events.event (Task 8.2, migration 016). The append-only audit vocabulary for the
 * key lifecycle. Failure events (`*_failed`) carry SANITIZED metadata only — never PII or key bytes.
 * MUST stay in sync with the migration-016 CHECK constraint by hand.
 */
export const LIFECYCLE_EVENTS = [
  'key_bootstrapped',
  'kek_rotated',
  'rotate_started',
  'rotate_completed',
  'destroy_requested',
  'destroy_confirmed',
  'revoke_dek',
  'revoke_kek',
  'rotate_failed',
  'revoke_failed',
  'destroy_finalize_failed',
] as const;
export const lifecycleEventSchema = z.enum(LIFECYCLE_EVENTS);
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

/** A stored key_lifecycle_events row. */
export const keyLifecycleEventRowSchema = z.object({
  id: z.string(),
  event: lifecycleEventSchema,
  key_version: z.number().int().nullable(),
  kek_version: z.string().nullable(),
  actor: z.string(),
  approval_ref: z.string().nullable(),
  confirmation_matched: z.boolean().nullable(),
  affected_raw_count: z.number().int().nullable(),
  affected_vault_count: z.number().int().nullable(),
  rows_reencrypted: z.number().int().nullable(),
  created_at: z.date(),
});
export type KeyLifecycleEventRow = z.infer<typeof keyLifecycleEventRowSchema>;

/** Insert shape — only `event` + `actor` are required; the rest default to NULL. */
export const keyLifecycleEventInsertSchema = z.object({
  event: lifecycleEventSchema,
  actor: z.string().min(1),
  keyVersion: z.number().int().nullable().optional(),
  kekVersion: z.string().nullable().optional(),
  approvalRef: z.string().nullable().optional(),
  confirmationMatched: z.boolean().nullable().optional(),
  affectedRawCount: z.number().int().nullable().optional(),
  affectedVaultCount: z.number().int().nullable().optional(),
  rowsReencrypted: z.number().int().nullable().optional(),
});
export type KeyLifecycleEventInsert = z.infer<typeof keyLifecycleEventInsertSchema>;
