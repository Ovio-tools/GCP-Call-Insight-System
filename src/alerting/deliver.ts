import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { renderAlertEventText } from '../failure-model/index.js';
import type { AlertEventRow } from '../db/schemas/alert-events.js';
import {
  claimAlertForDelivery,
  markDelivered,
  markFailed,
} from '../db/repositories/alert-events-repo.js';
import { type AlertWebhookPoster, httpPostAlert, sanitizeWebhookError } from './webhook.js';

/** The outcome of a single delivery attempt. */
export type DeliveryOutcome = 'delivered' | 'failed' | 'skipped';

export interface DeliverDeps {
  now: Date;
  logger: Logger;
  /** Injectable transport (defaults to the real HTTP POST). */
  post?: AlertWebhookPoster;
}

/** Coarse, log-safe token for an unknown throwable (never a raw message). */
function coarse(err: unknown): string {
  return err instanceof Error ? err.name || err.constructor.name : typeof err;
}

/**
 * Exponential backoff instant for THIS attempt: `base * 2^attemptsSoFar`, where `attemptsSoFar`
 * is the number of attempts made BEFORE this one (the pre-claim `delivery_attempts`). So the
 * first attempt (0 prior) schedules at `base`, the second at `2 * base`, etc. The caller
 * computes this once from the pre-claim count and uses the SAME instant for the claim's lease
 * and for the failure reschedule, so the two never drift and the counting is unaffected by the
 * claim's own increment.
 */
function nextAttemptAt(config: Config, now: Date, attemptsSoFar: number): Date {
  const factor = 2 ** Math.min(attemptsSoFar, 20); // cap the exponent, never overflow
  return new Date(now.getTime() + config.ALERT_DELIVERY_BACKOFF_MS * factor);
}

/** Mark a row failed at a precomputed next-attempt instant, swallowing (sanitized-logging) any
 * DB error so delivery never throws. */
async function safeMarkFailed(
  pool: Pool,
  id: string,
  nextAttempt: Date,
  reason: string,
  logger: Logger,
): Promise<void> {
  try {
    await markFailed(pool, id, { nextAttemptAt: nextAttempt, error: reason });
  } catch (err) {
    logger.warn({ component: 'alerting' }, `alert delivery bookkeeping failed (${coarse(err)})`);
  }
}

/**
 * Deliver ONE persisted alert row, best-effort and idempotently (Task 7.3). ATOMICALLY CLAIMS
 * the row before doing anything observable, then renders from the row alone
 * (`renderAlertEventText`), POSTs to `ALERT_WEBHOOK_URL`, and durably records the result. NEVER
 * throws into the caller and never leaks the URL/secret/PII:
 *
 *  - `ALERT_WEBHOOK_URL` unset → `skipped`: the row stays `pending`/`failed` and the sweep
 *    re-attempts later (logged once, not per row).
 *  - claim returns nothing → `skipped`, NO POST: the row was already delivered (a repeat
 *    escalation run), the max-attempts cap is hit, or a concurrent caller won the claim first.
 *    This is what makes overlapping sweeps and a re-run escalation deliver exactly once.
 *  - render throws (unrenderable legacy row) → `failed` with a sanitized reason; the sweep's
 *    max-attempts cap eventually stops retrying, leaving the row visible for follow-up.
 *  - POST fails → `failed`, `next_attempt_at` pushed out by exponential backoff (the attempt
 *    was already counted at claim), `last_delivery_error` sanitized (never the URL).
 *  - POST succeeds → `delivered` (idempotent: `markDelivered` no-ops a row already delivered).
 */
export async function deliverAlertRow(
  pool: Pool,
  config: Config,
  row: AlertEventRow,
  deps: DeliverDeps,
): Promise<DeliveryOutcome> {
  const { now, logger } = deps;
  const post = deps.post ?? httpPostAlert();

  if (!config.ALERT_WEBHOOK_URL) {
    return 'skipped';
  }

  // Backoff instant for THIS attempt, from the pre-claim count. One value serves BOTH the
  // claim's lease and the failure reschedule, so the documented `base * 2^attemptsSoFar` holds
  // regardless of the claim's own increment (first attempt → base, not 2*base).
  const nextRetryAt = nextAttemptAt(config, now, row.delivery_attempts);

  // Claim exactly one attempt before rendering/POSTing, leasing the row out of retry-
  // eligibility for one backoff interval so a concurrent sweep can't also send it (and so a
  // crash mid-POST self-heals once the lease elapses). If we lose the race, the row is already
  // delivered, or the cap is reached, no row comes back — skip WITHOUT sending.
  const claimed = await claimAlertForDelivery(pool, {
    id: row.id,
    expectedAttempts: row.delivery_attempts,
    maxAttempts: config.ALERT_DELIVERY_MAX_ATTEMPTS,
    leaseUntil: nextRetryAt,
  });
  if (!claimed) {
    return 'skipped';
  }

  let text: string;
  try {
    text = renderAlertEventText(claimed, { environment: config.NODE_ENV, now });
  } catch (err) {
    await safeMarkFailed(
      pool,
      claimed.id,
      nextRetryAt,
      `unrenderable alert (${coarse(err)})`,
      logger,
    );
    logger.warn(
      { component: 'alerting', error_code: claimed.error_code },
      `alert unrenderable — marked failed (${coarse(err)})`,
    );
    return 'failed';
  }

  try {
    await post(config.ALERT_WEBHOOK_URL, text, config.ALERT_WEBHOOK_TIMEOUT_MS);
    await markDelivered(pool, claimed.id);
    return 'delivered';
  } catch (err) {
    const reason = sanitizeWebhookError(err);
    await safeMarkFailed(pool, claimed.id, nextRetryAt, reason, logger);
    logger.warn(
      { component: 'alerting', error_code: claimed.error_code },
      `alert delivery failed: ${reason}`,
    );
    return 'failed';
  }
}
