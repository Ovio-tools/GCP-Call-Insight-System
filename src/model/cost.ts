import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import { query, withTransaction } from '../db/sql.js';
import {
  adjustDailyCost,
  getDay,
  upsertDailyCost,
} from '../db/repositories/daily-cost-usage-repo.js';

/**
 * Daily model-cost guardrail (Task 5.1), shared by every model stage (classify now,
 * extract in Task 5.2): reserve a conservative upper-bound cost before a model call,
 * then settle to actuals on success or release on a definitely-not-billed failure.
 * Reservation is atomic per UTC day, so parallel workers can never jointly overshoot
 * `DAILY_MODEL_COST_CAP_USD`.
 *
 * Failure semantics:
 * - A crash between reserve and settle leaks a conservative over-reservation for the
 *   rest of the day — the cap under-spends, it never over-spends.
 * - Maybe-billed transport failures (timeout after send, ambiguous 5xx) KEEP the
 *   reservation: the classify handler settles-to-reserved / does not release. Release
 *   is only for not_sent / not_billed failures.
 *
 * Accounting contract (mirrored on the daily-cost repo):
 * - `daily_cost_usage.estimated_cost` is conservative cap-accounting — it may include
 *   kept reservations for maybe-billed calls — NOT settled invoice cost.
 * - The token columns are actual received-response tokens only (reservations add 0).
 *
 * Task 7.2 scope boundary: this module detects the warning-threshold LEVEL (returning a pure
 * boolean flag on each admitted reservation), but does NO alerting and takes no `call_id`. The
 * advisory alert emission, its once-per-UTC-day dedup, and dashboard cost semantics live in the
 * pipeline layer (`src/pipeline/model-stage-shared.ts`). Any persisted model-kill-switch state
 * is deliberately absent — the hard cap is the atomic reservation-denial gate below.
 *
 * No transcript content and no call_id enter this module — only day keys and totals.
 */

/** Per-Mtok USD pricing. NO defaults anywhere in this module — every caller passes its
 * own stage's rates (classify: `CLASSIFY_COST_USD_PER_MTOK_*`; extract adds its own in
 * Task 5.2), so a different model can never silently inherit another stage's pricing. */
export interface ModelRates {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

export function estimateCostUsd(i: {
  inputTokens: number;
  outputTokens: number;
  rates: ModelRates;
}): number {
  return (
    (i.inputTokens * i.rates.inputUsdPerMtok + i.outputTokens * i.rates.outputUsdPerMtok) /
    1_000_000
  );
}

/**
 * GUARANTEED upper bound on input tokens:
 * `Buffer.byteLength(system + userText + outputFormatJson, 'utf8')` + `overheadTokens`.
 * A token always encodes >= 1 byte of text, so the UTF-8 byte count can never undercount;
 * the `overheadTokens` term covers structured-output/request scaffolding. Stage-agnostic
 * (no `Config` dependency) so Task 5.2's extract stage can reuse it, and symmetric with
 * `ModelRates`' no-defaults principle: the caller passes its own stage's overhead (classify:
 * `CLASSIFY_RESERVATION_OVERHEAD_TOKENS`). Reservation sizing in the caller uses
 * `max(CLASSIFY_INPUT_TOKENS_CEILING, estimatePayloadTokens(...))` — this module only
 * provides the pieces.
 */
export function estimatePayloadTokens(i: {
  system: string;
  userText: string;
  outputFormatJson: string;
  overheadTokens: number;
}): number {
  return Buffer.byteLength(i.system + i.userText + i.outputFormatJson, 'utf8') + i.overheadTokens;
}

/** UTC calendar day ('YYYY-MM-DD') for `now` — the cap window boundary is UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A held reservation against a day's cap. Each reservation must be settled OR released at
 * most once; the module does not enforce this (a double release on a shared day-total ledger
 * would free another reservation's budget).
 */
export interface BudgetReservation {
  day: string;
  reservedUsd: number;
  /**
   * Task 7.2: whether this admitted reservation lands the day's estimated spend AT OR ABOVE the
   * warning threshold (`DAILY_MODEL_COST_CAP_USD * DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO`). A
   * LEVEL check, not a low→high transition: it is `true` for EVERY admitted reservation at or
   * above the threshold, so a crash/swallowed-emit after one reservation cannot permanently miss
   * the warning. The pipeline layer collapses the repeated `true`s to at most one alert per UTC
   * day. `settle`/`release` ignore this field.
   */
  warningThresholdReached: boolean;
}

/**
 * Atomically reserve `requestCostUsd` against the day's cap, or return null when the
 * cap has no headroom (`estimated_cost + requestCostUsd > DAILY_MODEL_COST_CAP_USD`;
 * landing exactly on the cap is admitted). Single transaction: an advisory xact lock on
 * the day key serializes concurrent reservers, so check-then-write can never let two
 * near-cap requests both through.
 */
export async function reserveModelBudget(
  pool: Pool,
  input: { config: Config; now: Date; requestCostUsd: number },
): Promise<BudgetReservation | null> {
  const day = utcDay(input.now);
  return withTransaction(pool, async (client) => {
    // hashtextextended(text, 0) returns bigint, matching the single-bigint
    // advisory-lock overload (plain hashtext returns int, a different overload).
    await query(client, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `model-cost:${day}`,
    ]);
    const row = await getDay(client, day);
    const spentUsd = row ? Number(row.estimated_cost) : 0;
    if (spentUsd + input.requestCostUsd > input.config.DAILY_MODEL_COST_CAP_USD) {
      return null;
    }
    await upsertDailyCost(client, {
      day,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: input.requestCostUsd,
    });
    // Warning-threshold LEVEL (Task 7.2), computed on the same conservative estimated-spend basis
    // as the hard cap and status surface. Returned on every admitted reservation at/above the
    // threshold; the pipeline layer dedups the emits to one alert per UTC day. No alerting here.
    const warningUsd =
      input.config.DAILY_MODEL_COST_CAP_USD * input.config.DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO;
    const warningThresholdReached = spentUsd + input.requestCostUsd >= warningUsd;
    return { day, reservedUsd: input.requestCostUsd, warningThresholdReached };
  });
}

/** Replace the reservation with actuals: add the received token counts and shift the
 * cost by `actualUsd - reservedUsd` (negative when the upper bound was, as designed,
 * an overestimate). */
export async function settleModelUsage(
  pool: Pool,
  r: BudgetReservation,
  actual: { inputTokens: number; outputTokens: number; rates: ModelRates },
): Promise<void> {
  const actualUsd = estimateCostUsd({
    inputTokens: actual.inputTokens,
    outputTokens: actual.outputTokens,
    rates: actual.rates,
  });
  await adjustDailyCost(pool, {
    day: r.day,
    inputTokensDelta: actual.inputTokens,
    outputTokensDelta: actual.outputTokens,
    estimatedCostDelta: actualUsd - r.reservedUsd,
  });
}

/** Subtract the reservation in full — ONLY for not_sent / not_billed failures. A
 * maybe-billed failure keeps the reservation (see the module contract above). */
export async function releaseModelReservation(pool: Pool, r: BudgetReservation): Promise<void> {
  await adjustDailyCost(pool, {
    day: r.day,
    inputTokensDelta: 0,
    outputTokensDelta: 0,
    estimatedCostDelta: -r.reservedUsd,
  });
}
