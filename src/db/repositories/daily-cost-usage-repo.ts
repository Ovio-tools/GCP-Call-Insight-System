import { DAL_COST_ADJUST_REJECTED, DalError, parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type DailyCostAdjustment,
  type DailyCostUsageInput,
  type DailyCostUsageRow,
  dailyCostAdjustmentSchema,
  dailyCostUsageInputSchema,
  dailyCostUsageRowSchema,
} from '../schemas/daily-cost-usage.js';

/**
 * Accounting contract (mirrors src/model/cost.ts): `estimated_cost` is conservative
 * cap-accounting — it may include kept reservations for maybe-billed calls — NOT settled
 * invoice cost. The token columns are actual received-response tokens only.
 */
const TABLE = 'daily_cost_usage';

/** date/bigint/numeric come back as strings; cast day::text for a deterministic ISO date. */
const SELECT_COLS =
  `day::text AS day, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,` +
  ` estimated_cost::text AS estimated_cost, updated_at`;

/**
 * Add the day's token/cost amounts to the running totals (upsert on the date PK).
 * Accepts any {@link Queryable} so it can enlist in an open transaction — the budget
 * reservation writes it in the same commit as its cap check (src/model/cost.ts).
 */
export async function upsertDailyCost(
  q: Queryable,
  input: DailyCostUsageInput,
): Promise<DailyCostUsageRow> {
  const v = parseOrThrow(TABLE, dailyCostUsageInputSchema, input);
  const rows = await query<DailyCostUsageRow>(
    q,
    `INSERT INTO daily_cost_usage (day, input_tokens, output_tokens, estimated_cost)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (day) DO UPDATE SET
       input_tokens = daily_cost_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = daily_cost_usage.output_tokens + EXCLUDED.output_tokens,
       estimated_cost = daily_cost_usage.estimated_cost + EXCLUDED.estimated_cost,
       updated_at = now()
     RETURNING ${SELECT_COLS}`,
    [v.day, v.inputTokens, v.outputTokens, v.estimatedCost.toFixed(6)],
  );
  return parseOrThrow(TABLE, dailyCostUsageRowSchema, rows[0]);
}

export async function getDay(q: Queryable, day: string): Promise<DailyCostUsageRow | undefined> {
  const rows = await query<DailyCostUsageRow>(
    q,
    `SELECT ${SELECT_COLS} FROM daily_cost_usage WHERE day = $1`,
    [day],
  );
  return rows[0] ? parseOrThrow(TABLE, dailyCostUsageRowSchema, rows[0]) : undefined;
}

/**
 * Adjust an EXISTING day row: settlement (replace a reservation with actuals) or release
 * (subtract it). The cost delta may be negative; token deltas are nonnegative (schema).
 * The WHERE clause guards `estimated_cost + delta >= 0` in exact numeric arithmetic, so a
 * 0-row update means the day was never written or the caller over-released — both logic
 * bugs — and throws {@link DAL_COST_ADJUST_REJECTED} instead of writing a negative total.
 */
export async function adjustDailyCost(
  q: Queryable,
  input: DailyCostAdjustment,
): Promise<DailyCostUsageRow> {
  const v = parseOrThrow(TABLE, dailyCostAdjustmentSchema, input);
  const rows = await query<DailyCostUsageRow>(
    q,
    `UPDATE daily_cost_usage SET
       input_tokens = input_tokens + $2,
       output_tokens = output_tokens + $3,
       estimated_cost = estimated_cost + $4,
       updated_at = now()
     WHERE day = $1 AND estimated_cost + $4 >= 0
     RETURNING ${SELECT_COLS}`,
    [v.day, v.inputTokensDelta, v.outputTokensDelta, v.estimatedCostDelta.toFixed(6)],
  );
  if (!rows[0]) {
    throw new DalError(
      DAL_COST_ADJUST_REJECTED,
      `${DAL_COST_ADJUST_REJECTED}: daily_cost_usage ${v.day} missing or adjustment would drive estimated_cost negative`,
      { table: TABLE, day: v.day },
    );
  }
  return parseOrThrow(TABLE, dailyCostUsageRowSchema, rows[0]);
}
