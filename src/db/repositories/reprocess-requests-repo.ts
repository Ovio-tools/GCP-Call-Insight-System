import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type InsertReprocessRequestInput,
  type ReprocessRequestRow,
  insertReprocessRequestSchema,
  reprocessRequestRowSchema,
} from '../schemas/reprocess-requests.js';

const TABLE = 'reprocess_requests';

/**
 * Insert a reprocess/approve/correct_extraction outbox row (Task 6.2). Takes a {@link Queryable}
 * so the review-action handler enlists it in the SAME transaction as the `call_state` transition
 * and the `operator_actions` audit row — a durable outbox written atomically with the state
 * change. The UNIQUE(`operator_action_id`) makes it one-per-action: a duplicate POST writes no
 * second audit row (audit-trail idempotency) and thus never reaches this insert twice.
 */
export async function insertReprocessRequest(
  db: Queryable,
  input: InsertReprocessRequestInput,
): Promise<ReprocessRequestRow> {
  const v = parseOrThrow(TABLE, insertReprocessRequestSchema, input);
  const rows = await query<ReprocessRequestRow>(
    db,
    `INSERT INTO reprocess_requests
       (operator_action_id, call_id, review_queue_id, target_stage, requested_by,
        prior_stage, prior_status, prior_drop_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      v.operatorActionId,
      v.callId,
      v.reviewQueueId,
      v.targetStage,
      v.requestedBy,
      v.priorStage ?? null,
      v.priorStatus ?? null,
      v.priorDropReason ?? null,
    ],
  );
  return parseOrThrow(TABLE, reprocessRequestRowSchema, rows[0]);
}

/**
 * Ids of `pending` outbox rows, oldest first, excluding any already-attempted this run (mirrors
 * the stalled-review scan's exclusion set so the drain loop always terminates). The `::uuid[]`
 * cast is explicit even for the empty array. Read on the pool — the per-row lock is taken in the
 * drain's own transaction.
 */
export async function listPendingReprocessRequestIds(
  db: Queryable,
  opts: { excluded: readonly string[]; limit: number },
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    `SELECT id FROM reprocess_requests
      WHERE status = 'pending' AND NOT (id = ANY($1::uuid[]))
      ORDER BY created_at
      LIMIT $2`,
    [[...opts.excluded], opts.limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Lock a still-`pending` row by id with `FOR UPDATE SKIP LOCKED` — a concurrent drain holding the
 * row (or one that already sent/superseded it) yields zero rows, so no two drains double-enqueue.
 * Enlist in the drain's transaction so the `call_state` re-check + status transition happen under
 * the same lock.
 */
export async function lockPendingReprocessRequest(
  db: Queryable,
  id: string,
): Promise<ReprocessRequestRow | undefined> {
  const rows = await query<ReprocessRequestRow>(
    db,
    `SELECT * FROM reprocess_requests
      WHERE id = $1 AND status = 'pending'
      FOR UPDATE SKIP LOCKED`,
    [id],
  );
  return rows[0] ? parseOrThrow(TABLE, reprocessRequestRowSchema, rows[0]) : undefined;
}

/** Mark a pending row `sent` after a successful enqueue. Guarded on `status='pending'` so a
 * concurrent transition can't be clobbered. */
export async function markReprocessSent(db: Queryable, id: string, now: Date): Promise<void> {
  await query(
    db,
    `UPDATE reprocess_requests SET status = 'sent', sent_at = $2
      WHERE id = $1 AND status = 'pending'`,
    [id, now],
  );
}

/** Mark a pending row `superseded` — the drain's `call_state` re-check found the call no longer
 * `processing`@`target_stage`, so the stale reprocess must NOT be enqueued. */
export async function markReprocessSuperseded(db: Queryable, id: string): Promise<void> {
  await query(
    db,
    `UPDATE reprocess_requests SET status = 'superseded'
      WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

/**
 * Record an enqueue-attempt failure: bump `attempt_count`, store a SANITIZED `last_error_code`
 * (a failure-model code, never a raw message or PII) + `last_attempted_at`, and leave the row
 * `pending` so the next drain retries it. The missed row keeps the drain INCOMPLETE (the cron
 * withholds its heartbeat).
 */
export async function recordReprocessAttemptFailure(
  db: Queryable,
  id: string,
  errorCode: string,
  now: Date,
): Promise<void> {
  await query(
    db,
    `UPDATE reprocess_requests
        SET attempt_count = attempt_count + 1, last_error_code = $2, last_attempted_at = $3
      WHERE id = $1 AND status = 'pending'`,
    [id, errorCode, now],
  );
}

/** Read a row by id — test/diagnostics helper. */
export async function getReprocessRequestById(
  db: Queryable,
  id: string,
): Promise<ReprocessRequestRow | undefined> {
  const rows = await query<ReprocessRequestRow>(
    db,
    `SELECT * FROM reprocess_requests WHERE id = $1`,
    [id],
  );
  return rows[0] ? parseOrThrow(TABLE, reprocessRequestRowSchema, rows[0]) : undefined;
}

/** Read a row by its owning action id — used by the terminal idempotency check to confirm a
 * duplicate reprocess wrote no second outbox row. */
export async function getReprocessRequestByActionId(
  db: Queryable,
  operatorActionId: string,
): Promise<ReprocessRequestRow | undefined> {
  const rows = await query<ReprocessRequestRow>(
    db,
    `SELECT * FROM reprocess_requests WHERE operator_action_id = $1`,
    [operatorActionId],
  );
  return rows[0] ? parseOrThrow(TABLE, reprocessRequestRowSchema, rows[0]) : undefined;
}
