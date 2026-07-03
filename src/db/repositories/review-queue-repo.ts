import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, withTransaction } from '../sql.js';
import { type ReviewStatus, reviewStatusSchema } from '../enums.js';
import {
  type EnqueueReviewInput,
  type ReviewQueueRow,
  enqueueReviewInputSchema,
  reviewQueueRowSchema,
} from '../schemas/review-queue.js';

const TABLE = 'review_queue';

/**
 * Enqueue a held call for review with a held_reason + SLA, idempotent per call: inside a
 * transaction it locks the `call_state` row (`FOR UPDATE`) to serialize concurrent
 * holds, and returns the existing open/in-review row if one is already present rather
 * than creating a duplicate. A resolved/unresolvable call can be re-held later.
 */
export async function enqueueReview(
  pool: Pool,
  input: EnqueueReviewInput,
): Promise<ReviewQueueRow> {
  const v = parseOrThrow(TABLE, enqueueReviewInputSchema, input);
  return withTransaction(pool, async (client) => {
    await query(client, `SELECT 1 FROM call_state WHERE call_id = $1 FOR UPDATE`, [v.callId]);

    const existing = await query<ReviewQueueRow>(
      client,
      `SELECT * FROM review_queue
        WHERE call_id = $1 AND status IN ('open', 'in_review')
        ORDER BY created_at
        LIMIT 1`,
      [v.callId],
    );
    if (existing[0]) {
      return parseOrThrow(TABLE, reviewQueueRowSchema, existing[0]);
    }

    const rows = await query<ReviewQueueRow>(
      client,
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at, assignee)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [v.callId, v.heldReason, v.slaDueAt, v.assignee ?? null],
    );
    return parseOrThrow(TABLE, reviewQueueRowSchema, rows[0]);
  });
}

/**
 * Whether an ACTIVE (open/in_review) review_queue row exists for a call. The runner's `held`
 * terminal guard uses this to confirm a held call is still genuinely awaiting review. A
 * resolved/unresolvable row does NOT count: a call whose review has been resolved must be
 * moved off `status='held'` by the resolution path (reprocess, or a terminal resolved status,
 * Task 6.x) — a `held` call_state with no active review is an inconsistency, not a live hold.
 */
export async function hasActiveReviewForCall(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM review_queue WHERE call_id = $1 AND status IN ('open', 'in_review') LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

export async function getReview(pool: Pool, id: string): Promise<ReviewQueueRow | undefined> {
  const rows = await query<ReviewQueueRow>(pool, `SELECT * FROM review_queue WHERE id = $1`, [id]);
  return rows[0] ? parseOrThrow(TABLE, reviewQueueRowSchema, rows[0]) : undefined;
}

export async function listOpen(pool: Pool): Promise<ReviewQueueRow[]> {
  const rows = await query<ReviewQueueRow>(
    pool,
    `SELECT * FROM review_queue WHERE status IN ('open', 'in_review') ORDER BY created_at`,
  );
  return rows.map((r) => parseOrThrow(TABLE, reviewQueueRowSchema, r));
}

/**
 * Move a held call to a new review status; stamps resolved_at when leaving the queue.
 * `assignee` is set-if-provided (COALESCE keeps the current value when omitted); there is
 * deliberately no "clear the assignee" path here, so the type excludes null.
 */
export async function setStatus(
  pool: Pool,
  id: string,
  status: ReviewStatus,
  opts: { assignee?: string } = {},
): Promise<ReviewQueueRow | undefined> {
  const parsedStatus = reviewStatusSchema.parse(status);
  const resolved = parsedStatus === 'resolved' || parsedStatus === 'unresolvable';
  const rows = await query<ReviewQueueRow>(
    pool,
    `UPDATE review_queue
        SET status = $2,
            assignee = COALESCE($3, assignee),
            resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END
      WHERE id = $1
      RETURNING *`,
    [id, parsedStatus, opts.assignee ?? null, resolved],
  );
  return rows[0] ? parseOrThrow(TABLE, reviewQueueRowSchema, rows[0]) : undefined;
}
