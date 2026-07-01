import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type DailyCostUsageInput,
  type DailyCostUsageRow,
  dailyCostUsageInputSchema,
  dailyCostUsageRowSchema,
} from '../schemas/daily-cost-usage.js';

const TABLE = 'daily_cost_usage';

/** date/bigint/numeric come back as strings; cast day::text for a deterministic ISO date. */
const SELECT_COLS =
  `day::text AS day, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,` +
  ` estimated_cost::text AS estimated_cost, updated_at`;

/** Add the day's token/cost amounts to the running totals (upsert on the date PK). */
export async function upsertDailyCost(
  pool: Pool,
  input: DailyCostUsageInput,
): Promise<DailyCostUsageRow> {
  const v = parseOrThrow(TABLE, dailyCostUsageInputSchema, input);
  const rows = await query<DailyCostUsageRow>(
    pool,
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

export async function getDay(pool: Pool, day: string): Promise<DailyCostUsageRow | undefined> {
  const rows = await query<DailyCostUsageRow>(
    pool,
    `SELECT ${SELECT_COLS} FROM daily_cost_usage WHERE day = $1`,
    [day],
  );
  return rows[0] ? parseOrThrow(TABLE, dailyCostUsageRowSchema, rows[0]) : undefined;
}
