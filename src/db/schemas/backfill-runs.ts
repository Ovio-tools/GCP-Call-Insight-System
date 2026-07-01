import { z } from 'zod';

/** backfill_runs — batch windows + checkpoints. PK: id. */
export const backfillRunRowSchema = z.object({
  id: z.string().uuid(),
  window_start: z.date(),
  window_end: z.date(),
  last_checkpoint: z.string().nullable(),
  status: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type BackfillRunRow = z.infer<typeof backfillRunRowSchema>;

export const backfillRunInsertSchema = z.object({
  windowStart: z.date(),
  windowEnd: z.date(),
  status: z.string().min(1),
  lastCheckpoint: z.string().nullable().optional(),
});
export type BackfillRunInsert = z.infer<typeof backfillRunInsertSchema>;
