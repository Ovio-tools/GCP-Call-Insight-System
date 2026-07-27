import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { query, withTransaction } from '../db/sql.js';
import { acknowledgeAlert, acknowledgeAlertsForCall } from '../db/repositories/alert-events-repo.js';
import { recordOperatorAction } from '../db/repositories/operator-actions-repo.js';
import { markUnresolvableByReviewId } from '../db/repositories/review-queue-repo.js';
import { reviewStalledDedupKey } from './sla.js';

/** Default drain batch size. Small in tests to exercise multi-batch draining. */
const DEFAULT_BATCH_SIZE = 500;

/**
 * The audit actor for an automatic closure. Namespaced `system:` so `operator_actions` — the
 * record of who decided what — never implies a person made this call.
 */
export const ABANDON_ACTOR = 'system:transcript-abandon';

export interface AbandonResult {
  /** Holds closed as unresolvable this run. */
  closed: number;
  /** Holds whose transcript unexpectedly DID arrive; left open for a person. */
  recovered: number;
  /** Due rows another transaction held (or a person claimed) between the read and the lock.
   * Not a failure — the next run picks them up — so these never withhold the heartbeat. */
  skipped: number;
  /** Rows whose probe or transaction threw. Rolled back and still eligible next run; a
   * non-zero value marks the run INCOMPLETE so the caller withholds the cron heartbeat. */
  failed: number;
}

export interface AbandonDeps {
  /**
   * Probe: does Dialpad have a transcript for this call NOW? Injected so this module never
   * depends on the concrete Dialpad client and stays unit-testable. A rejection is counted as
   * `failed` and closes nothing — we never abandon a hold on the strength of a failed probe.
   */
  isTranscriptReady: (callId: string) => Promise<boolean>;
  /** Drain batch size (default {@link DEFAULT_BATCH_SIZE}). */
  batchSize?: number;
}

/**
 * Close out `missing_transcript` holds that no person can ever resolve (the auto-close duty).
 *
 * A held call waits `DIALPAD_TRANSCRIPT_WAIT_MAX_MS` for its transcript and is then queued for
 * review. But when Dialpad simply never produced a transcript — the observed case is a 200
 * response carrying a bare `{call_id}` envelope with no content, permanently — there is nothing
 * for a reviewer to do: the row sits open forever, breaches its SLA, and emits a
 * `REVIEW_QUEUE_STALLED` alert nobody can action. This duty ends that cycle.
 *
 * For every UNCLAIMED `missing_transcript` hold older than `TRANSCRIPT_ABANDON_AFTER_MS` it asks
 * Dialpad once more, and only if the transcript is STILL absent does it close the item
 * (`unresolvable` + `call_state` → `review_closed`), write the `mark_unresolvable` audit row
 * under {@link ABANDON_ACTOR}, and acknowledge the alerts the hold raised. A hold whose
 * transcript has since appeared is deliberately left OPEN for a person — the safe direction,
 * and the interlock that stops a probe outage from mass-closing recoverable work.
 *
 * Fail-safe throughout: a claimed hold (assigned, or `in_review`) is never touched, a probe
 * failure closes nothing, and each item commits in its own transaction so one bad row cannot
 * roll back another's closure. Every already-attempted id is excluded from later batches, so
 * the drain always terminates.
 */
export async function abandonUnfixableTranscriptHolds(
  pool: Pool,
  config: Config,
  logger: Logger,
  now: Date,
  deps: AbandonDeps,
): Promise<AbandonResult> {
  const result: AbandonResult = { closed: 0, recovered: 0, skipped: 0, failed: 0 };
  if (!config.TRANSCRIPT_ABANDON_ENABLED) return result;

  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - config.TRANSCRIPT_ABANDON_AFTER_MS);
  const attempted = new Set<string>();

  for (;;) {
    // The `::uuid[]` cast is explicit even for the empty array — an untyped empty array errors
    // the query before it processes anything.
    const due = await query<{ id: string; call_id: string }>(
      pool,
      `SELECT id, call_id FROM review_queue
        WHERE held_reason = 'missing_transcript'
          AND status = 'open'
          AND assignee IS NULL
          AND created_at < $1
          AND NOT (id = ANY($2::uuid[]))
        ORDER BY created_at
        LIMIT $3`,
      [cutoff, [...attempted], batchSize],
    );
    if (due.length === 0) break;

    for (const { id, call_id: callId } of due) {
      // Every id read in this batch is attempted exactly once, whatever the outcome — closed
      // rows self-exclude via `status`, but recovered/skipped/failed ones would otherwise be
      // re-selected forever.
      attempted.add(id);

      // The probe runs OUTSIDE the transaction: a network round-trip must never be made while
      // holding a row lock.
      let ready: boolean;
      try {
        ready = await deps.isTranscriptReady(callId);
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { component: 'reconciliation-cron', call_id: callId, review_queue_id: id },
          `transcript re-check failed, hold left open: ${err instanceof Error ? err.name : typeof err}`,
        );
        continue;
      }

      if (ready) {
        // Unexpected but welcome: the transcript arrived after all. Closing it would discard a
        // recoverable call, so leave it for a person (who can re-drive it through reprocess).
        result.recovered += 1;
        logger.info(
          { component: 'reconciliation-cron', call_id: callId, review_queue_id: id },
          'transcript has since arrived — leaving the hold open for review',
        );
        continue;
      }

      try {
        const closed = await withTransaction(pool, async (client) => {
          // Re-check under lock with the SAME guards. No row ⇒ a concurrent transaction holds
          // it, or a person claimed/resolved it since the batch read — either way, not ours.
          const locked = await query<{ id: string }>(
            client,
            `SELECT id FROM review_queue
              WHERE id = $1 AND status = 'open' AND assignee IS NULL
              FOR UPDATE SKIP LOCKED`,
            [id],
          );
          if (locked.length === 0) return false;

          const transition = await markUnresolvableByReviewId(client, id, ABANDON_ACTOR);
          await recordOperatorAction(client, {
            reviewQueueId: id,
            actor: ABANDON_ACTOR,
            action: 'mark_unresolvable',
            before: transition.before,
            after: transition.after,
          });
          // Clear what this hold was nagging about, in the SAME transaction so the banners
          // vanish atomically with the closure (and roll back with it if anything throws):
          // the item's own stalled-review alert, plus every open alert scoped to this call —
          // which is what silences the DIALPAD_TRANSCRIPT_MISSING alert that started it all.
          await acknowledgeAlert(client, reviewStalledDedupKey(id));
          await acknowledgeAlertsForCall(client, callId);
          return true;
        });

        if (closed) {
          result.closed += 1;
          logger.info(
            { component: 'reconciliation-cron', call_id: callId, review_queue_id: id },
            'transcript never arrived — hold closed as unresolvable',
          );
        } else {
          result.skipped += 1;
        }
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { component: 'reconciliation-cron', call_id: callId, review_queue_id: id },
          `abandoning transcript hold failed: ${err instanceof Error ? err.name : typeof err}`,
        );
      }
    }
  }

  return result;
}
