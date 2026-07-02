import { z } from 'zod';

/** daily_cost_usage — per-day token + cost totals. PK: day. */
export const dailyCostUsageRowSchema = z.object({
  // Read as `day::text` -> 'YYYY-MM-DD'; bigint / numeric come back as strings.
  day: z.string(),
  input_tokens: z.string(),
  output_tokens: z.string(),
  estimated_cost: z.string(),
  updated_at: z.date(),
});
export type DailyCostUsageRow = z.infer<typeof dailyCostUsageRowSchema>;

/** Amounts to ADD to the day's running totals (idempotency is the caller's job via the
 * job key; the upsert accumulates). Day is an ISO 'YYYY-MM-DD' date string. */
export const dailyCostUsageInputSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  // `.finite()` rejects Infinity/NaN at the boundary as DAL_VALIDATION_FAILED rather than
  // letting `Infinity.toFixed(6)` reach pg as the string "Infinity".
  estimatedCost: z.number().finite().nonnegative(),
});
export type DailyCostUsageInput = z.infer<typeof dailyCostUsageInputSchema>;

/** Adjustment to an EXISTING day row (reservation settlement/release, Task 5.1). The
 * cost delta may be negative — settling below the reservation or releasing it — but
 * token deltas are actual received-response counts and never negative. */
export const dailyCostAdjustmentSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokensDelta: z.number().int().nonnegative(),
  outputTokensDelta: z.number().int().nonnegative(),
  // `.finite()` rejects Infinity/NaN at the boundary as DAL_VALIDATION_FAILED rather than
  // letting `(±Infinity).toFixed(6)` reach pg as the string "Infinity".
  estimatedCostDelta: z.number().finite(),
});
export type DailyCostAdjustment = z.infer<typeof dailyCostAdjustmentSchema>;
