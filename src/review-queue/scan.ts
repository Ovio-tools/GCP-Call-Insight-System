import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { query, withTransaction } from '../db/sql.js';
import type { JsonValue, Queryable } from '../db/types.js';
import { recordAlertWithInsertStatus } from '../db/repositories/alert-events-repo.js';
import type { AlertEventInsert } from '../db/schemas/alert-events.js';
import { createFailure } from '../failure-model/index.js';
import { reviewStalledDedupKey } from './sla.js';

/** Default drain batch size. Small in tests to exercise multi-batch draining. */
const DEFAULT_BATCH_SIZE = 500;

export interface ScanResult {
  /** Rows escalated + alerted this run. */
  escalated: number;
  /** Rows whose per-item transaction threw (alert insert failed, etc.) — rolled back, still
   * eligible next run. A non-zero value marks the scan INCOMPLETE (the caller withholds the
   * cron heartbeat). */
  failed: number;
  /** Due rows this run could not process because their row was locked by a concurrent
   * transaction (or escalated by one between the batch read and the re-check). Also marks the
   * scan INCOMPLETE — fail safe rather than go green with an unalerted stalled item. */
  lockedSkipped: number;
}

export interface ScanStalledReviewsDeps {
  /** Injectable alert recorder, enlisted in the per-item transaction. Defaults to the real
   * `recordAlertWithInsertStatus`. Tests inject a throwing recorder to exercise the
   * rollback / lost-alert path. */
  recordAlert?: (client: Queryable, input: AlertEventInsert) => Promise<unknown>;
  /** Drain batch size (default {@link DEFAULT_BATCH_SIZE}). */
  batchSize?: number;
}

/** The sanitized `failure_snapshot` for a stalled-review alert: the shared failure fields plus
 * safe review metadata. NO transcript content or PII — `context` is `{call_id, environment}`. */
function buildSnapshot(
  failure: ReturnType<typeof createFailure>,
  row: { id: string; held_reason: string },
): JsonValue {
  return {
    error_code: failure.error_code,
    root_cause_category: failure.root_cause_category,
    severity: failure.severity,
    impact: failure.impact,
    processing_state: failure.processing_state,
    remediation_now: failure.remediation_now,
    remediation_fix: failure.remediation_fix,
    data_safe: failure.data_safe,
    calls_state: failure.calls_state,
    owner: failure.owner,
    runbook_ref: failure.runbook_ref,
    context: failure.context,
    held_reason: row.held_reason,
    review_queue_id: row.id,
  };
}

/**
 * Escalate every SLA-breaching review item once and emit exactly one `REVIEW_QUEUE_STALLED`
 * alert per item, without losing alerts or spinning (Task 6.1 §4).
 *
 * Drains the whole due set in bounded batches. Each id is processed in its OWN transaction:
 * re-check `FOR UPDATE SKIP LOCKED`, record the alert (enlisted in the same tx), stamp
 * `escalated_at`, commit. If the alert insert throws, the tx rolls back — `escalated_at` stays
 * null so the item is retried next run (no lost alert, no silent escalation). A row that is
 * locked or already-escalated-by-a-concurrent-run under the re-check is counted as
 * `lockedSkipped`. Every already-attempted id (failed ∪ lockedSkipped) is excluded from later
 * batches — successfully escalated rows self-exclude via `escalated_at IS NULL` — so the loop
 * always terminates and never re-selects a locked row.
 *
 * The dedup key is scoped to the review ITEM (`REVIEW_QUEUE_STALLED:review_queue:<id>`), never
 * the call, so a re-held call gets its own alert and a stale prior alert can't suppress a new
 * item. A non-zero `failed` OR `lockedSkipped` marks the scan incomplete; the caller withholds
 * the reconciliation heartbeat so a broken scan surfaces via the missed check.
 */
export async function scanStalledReviews(
  pool: Pool,
  config: Config,
  logger: Logger,
  now: Date,
  deps: ScanStalledReviewsDeps = {},
): Promise<ScanResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const recordAlert = deps.recordAlert ?? recordAlertWithInsertStatus;

  const failed = new Set<string>();
  const lockedSkipped = new Set<string>();
  let escalated = 0;

  for (;;) {
    // Exclude every already-attempted id. The `::uuid[]` cast is explicit even for the empty
    // array — an untyped empty array errors the query before it processes anything.
    const excluded = [...failed, ...lockedSkipped];
    const due = await query<{ id: string }>(
      pool,
      `SELECT id FROM review_queue
        WHERE status IN ('open', 'in_review')
          AND sla_due_at < $1
          AND escalated_at IS NULL
          AND NOT (id = ANY($2::uuid[]))
        ORDER BY sla_due_at
        LIMIT $3`,
      [now, excluded, batchSize],
    );
    if (due.length === 0) break;

    for (const { id } of due) {
      try {
        const escalatedThisItem = await withTransaction(pool, async (client) => {
          // Re-check under lock. No row ⇒ locked by a concurrent tx, or escalated by one since
          // the batch read (the batch already filtered escalated_at IS NULL) — either way this
          // run could not process it.
          const locked = await query<{ id: string; call_id: string; held_reason: string }>(
            client,
            `SELECT id, call_id, held_reason FROM review_queue
              WHERE id = $1 AND escalated_at IS NULL
              FOR UPDATE SKIP LOCKED`,
            [id],
          );
          if (locked.length === 0) return false;
          const row = locked[0]!;

          const failure = createFailure('REVIEW_QUEUE_STALLED', {
            processingState: 'degraded',
            context: { call_id: row.call_id, environment: config.NODE_ENV },
          });
          await recordAlert(client, {
            errorCode: failure.error_code,
            rootCauseCategory: failure.root_cause_category,
            severity: failure.severity,
            dedupKey: reviewStalledDedupKey(row.id),
            failureSnapshot: buildSnapshot(failure, row),
          });
          // If recordAlert threw, this UPDATE never runs and the tx rolls back → eligible next run.
          await query(
            client,
            `UPDATE review_queue SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL`,
            [id],
          );
          return true;
        });

        if (escalatedThisItem) escalated += 1;
        else lockedSkipped.add(id);
      } catch (err) {
        // Per-item failure: rolled back, tallied, iteration continues to the next id.
        failed.add(id);
        logger.warn(
          { component: 'reconciliation-cron', review_queue_id: id },
          `stalled-review escalation failed: ${err instanceof Error ? err.name : typeof err}`,
        );
      }
    }
  }

  return { escalated, failed: failed.size, lockedSkipped: lockedSkipped.size };
}
