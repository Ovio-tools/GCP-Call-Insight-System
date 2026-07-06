import { z } from 'zod';

/**
 * The backfill run lifecycle (Task 11.2), pinned by the migration-018 CHECK. `running` →
 * (`completed` | `interrupted` | `failed`). `running`/`interrupted`/`failed` are all RESUMABLE;
 * only `completed` is final. Kept as a zod enum so the repo/orchestrator can never write a status
 * the DB CHECK would reject.
 */
export const BACKFILL_RUN_STATUSES = ['running', 'completed', 'interrupted', 'failed'] as const;
export const backfillRunStatusSchema = z.enum(BACKFILL_RUN_STATUSES);
export type BackfillRunStatus = z.infer<typeof backfillRunStatusSchema>;

/** The three RESUMABLE statuses: a run in any of these can be continued (and is covered by the
 * UNIQUE partial index enforcing at most one resumable run per window). */
export const RESUMABLE_BACKFILL_RUN_STATUSES = ['running', 'interrupted', 'failed'] as const;

/** backfill_runs — batch windows + checkpoints. PK: id. */
export const backfillRunRowSchema = z.object({
  id: z.string().uuid(),
  window_start: z.date(),
  window_end: z.date(),
  last_checkpoint: z.string().nullable(),
  status: backfillRunStatusSchema,
  created_at: z.date(),
  updated_at: z.date(),
});
export type BackfillRunRow = z.infer<typeof backfillRunRowSchema>;

export const backfillRunInsertSchema = z.object({
  windowStart: z.date(),
  windowEnd: z.date(),
  status: backfillRunStatusSchema,
  lastCheckpoint: z.string().nullable().optional(),
});
export type BackfillRunInsert = z.infer<typeof backfillRunInsertSchema>;
