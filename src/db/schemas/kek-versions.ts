import { z } from 'zod';

/** kek_versions.status — a KEK is active, retired (still unwraps its DEKs), or destroyed. */
export const kekVersionStatusSchema = z.enum(['active', 'retired', 'destroyed']);
export type KekVersionStatus = z.infer<typeof kekVersionStatusSchema>;

/**
 * kek_versions (Task 8.2, migration 016) — durable authoritative KEK state. `external_kek_ref` is
 * a pointer to the KEK in the external secret store; NEVER key bytes. The launch gate reads this
 * (not events) to confirm destroyed-KEK state. PK: kek_version.
 */
export const kekVersionRowSchema = z.object({
  kek_version: z.string(),
  status: kekVersionStatusSchema,
  external_kek_ref: z.string(),
  destroy_requested_at: z.date().nullable(),
  destroy_recovery_window_until: z.date().nullable(),
  destroy_approval_ref: z.string().nullable(),
  created_at: z.date(),
  destroyed_at: z.date().nullable(),
});
export type KekVersionRow = z.infer<typeof kekVersionRowSchema>;

export const kekVersionInsertSchema = z.object({
  kekVersion: z.string().min(1),
  externalKekRef: z.string().min(1),
  status: kekVersionStatusSchema.default('active'),
});
export type KekVersionInsert = z.infer<typeof kekVersionInsertSchema>;
