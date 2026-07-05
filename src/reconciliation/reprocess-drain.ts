import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { query, withTransaction } from '../db/sql.js';
import {
  listPendingReprocessRequestIds,
  lockPendingReprocessRequest,
  markReprocessSent,
  markReprocessSuperseded,
  recordReprocessAttemptFailure,
} from '../db/repositories/reprocess-requests-repo.js';

/** Default drain batch size. Small in tests to exercise multi-batch draining. */
const DEFAULT_BATCH_SIZE = 500;

/** The sanitized error code stored when an enqueue attempt fails for an unclassified reason —
 * an enqueue failure is almost always Redis being unreachable. Never a raw message or PII. */
const DEFAULT_ENQUEUE_ERROR_CODE = 'REDIS_UNAVAILABLE';

export interface ReprocessDrainRow {
  callId: string;
  targetStage: string;
  reviewQueueId: string;
}

export interface DrainResult {
  /** Rows enqueued + marked `sent` this run. */
  enqueued: number;
  /** Rows whose `call_state` no longer matched (`processing`@`target_stage`) and were marked
   * `superseded` rather than enqueued. Not a failure — a benign later-recovery outcome. */
  superseded: number;
  /** Rows whose enqueue failed (left `pending`, `attempt_count` bumped) OR whose per-item tx
   * threw. A non-zero value marks the drain INCOMPLETE so the cron withholds its heartbeat. */
  failed: number;
}

export interface DrainDeps {
  /** Enqueue the reprocess job (deterministic reprocess job id). Injected so the DB drain stays
   * unit-testable and the queue wiring lives in the cron entrypoint. */
  enqueue: (row: ReprocessDrainRow) => Promise<void>;
  batchSize?: number;
  now?: Date;
  logger?: Logger;
}

/** Best-effort sanitized code for a failed enqueue: a failure-model `code`/`error_code`
 * property if present, else the Redis default. Never surfaces a raw message. */
function sanitizedEnqueueErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code =
      (err as { code?: unknown; error_code?: unknown }).code ??
      (err as { error_code?: unknown }).error_code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  }
  return DEFAULT_ENQUEUE_ERROR_CODE;
}

/**
 * Drain the durable `reprocess_requests` outbox (Task 6.2) — the crash/Redis-outage recovery a
 * best-effort post-commit enqueue can leave stranded (the requeue-parked scripts do NOT rescue a
 * generic `processing` row; they only match kill-switch markers). Mirrors {@link scanStalledReviews}:
 * select a batch of `pending` ids, then process each in its OWN transaction —
 * `FOR UPDATE SKIP LOCKED` re-lock, re-check `call_state` under that lock, then enqueue + mark
 * `sent`, or mark `superseded` when the call moved on, or record the enqueue failure and leave it
 * `pending`. A locked row (a concurrent drain owns it) is excluded so the loop terminates without
 * double-enqueue. `failed > 0` marks the drain INCOMPLETE; the reconciliation cron withholds its
 * external ping so the missed check is the alert.
 */
export async function drainPendingReprocessRequests(
  pool: Pool,
  deps: DrainDeps,
): Promise<DrainResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = deps.now ?? new Date();

  const failed = new Set<string>();
  const lockedSkipped = new Set<string>();
  let enqueued = 0;
  let superseded = 0;

  for (;;) {
    const excluded = [...failed, ...lockedSkipped];
    const ids = await listPendingReprocessRequestIds(pool, { excluded, limit: batchSize });
    if (ids.length === 0) break;

    for (const id of ids) {
      try {
        const outcome = await withTransaction(pool, async (client) => {
          const row = await lockPendingReprocessRequest(client, id);
          // No row ⇒ locked by a concurrent drain, or already sent/superseded since the batch
          // read. Either way this run does not own it.
          if (!row) return 'skip' as const;

          // Re-check call_state under the same lock. A later operator/manual recovery may have
          // moved the call; re-pulling stale work would double-process. Require exactly
          // processing@target_stage.
          const cs = await query<{ status: string; current_stage: string }>(
            client,
            `SELECT status, current_stage FROM call_state WHERE call_id = $1`,
            [row.call_id],
          );
          const state = cs[0];
          if (!state || state.status !== 'processing' || state.current_stage !== row.target_stage) {
            await markReprocessSuperseded(client, id);
            return 'superseded' as const;
          }

          // Enqueue inside the tx so the row stays locked across it. On failure, record a
          // sanitized attempt-failure and COMMIT the increment (leave it pending for retry).
          try {
            await deps.enqueue({
              callId: row.call_id,
              targetStage: row.target_stage,
              reviewQueueId: row.review_queue_id,
            });
          } catch (err) {
            await recordReprocessAttemptFailure(client, id, sanitizedEnqueueErrorCode(err), now);
            return 'failed' as const;
          }
          await markReprocessSent(client, id, now);
          return 'sent' as const;
        });

        if (outcome === 'sent') enqueued += 1;
        else if (outcome === 'superseded') superseded += 1;
        else if (outcome === 'failed') failed.add(id);
        else lockedSkipped.add(id);
      } catch (err) {
        // Per-item tx-level failure: rolled back, tallied, iteration continues.
        failed.add(id);
        deps.logger?.warn(
          { component: 'reconciliation-cron', reprocess_request_id: id },
          `reprocess drain item failed: ${err instanceof Error ? err.name : typeof err}`,
        );
      }
    }
  }

  return { enqueued, superseded, failed: failed.size };
}
