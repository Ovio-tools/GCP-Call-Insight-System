import { z } from 'zod';

/**
 * backfill_run_calls (Task 11.2) — the terminal-completion tracking table. One row per call a
 * backfill run enqueues OR rescues, so a rescued pre-existing seed (already a `call_state` row,
 * never re-stamped with a run id) is still awaited by the drain phase. Composite PK
 * `(backfill_run_id, call_id)`; non-PII (ids + timestamp only).
 */
export const backfillRunCallRowSchema = z.object({
  backfill_run_id: z.string().uuid(),
  call_id: z.string(),
  created_at: z.date(),
});
export type BackfillRunCallRow = z.infer<typeof backfillRunCallRowSchema>;
