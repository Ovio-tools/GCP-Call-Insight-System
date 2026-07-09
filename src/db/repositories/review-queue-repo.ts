import type { Pool } from 'pg';
import { DAL_REVIEW_INVARIANT, DAL_VALIDATION_FAILED, DalError, parseOrThrow } from '../errors.js';
import { query, withTransaction } from '../sql.js';
import type { Queryable } from '../types.js';
import { type ReviewStatus, reviewStatusSchema } from '../enums.js';
import { recordOperatorAction } from './operator-actions-repo.js';
import {
  type EnqueueReviewInput,
  type ReviewQueueRow,
  enqueueReviewInputSchema,
  reviewQueueRowSchema,
} from '../schemas/review-queue.js';

const TABLE = 'review_queue';

/**
 * Enqueue a held call for review with a held_reason + SLA, idempotent per call. The INSERT
 * targets the partial unique index (`review_queue_one_active_per_call`) BY INFERENCE (`ON
 * CONFLICT (call_id) WHERE status IN ('open','in_review') DO NOTHING`), so two concurrent
 * enqueues collapse to exactly one active row.
 *
 * The readback is a SEPARATE statement, NOT a sibling `SELECT` in the same CTE. Under READ
 * COMMITTED a single statement uses ONE snapshot taken at its start: if a concurrent
 * transaction inserts the active row and commits WHILE this one is blocked on the conflict, a
 * same-statement `SELECT` would still use the pre-commit snapshot and miss it (returning no
 * row → a spurious throw). A fresh statement takes a new snapshot and sees the just-committed
 * row — mirroring `holdCall`'s two-step read. A resolved/unresolvable call can be re-held later
 * (those rows are outside the partial index).
 */
export async function enqueueReview(
  pool: Pool,
  input: EnqueueReviewInput,
): Promise<ReviewQueueRow> {
  const v = parseOrThrow(TABLE, enqueueReviewInputSchema, input);
  const inserted = await query<ReviewQueueRow>(
    pool,
    `INSERT INTO review_queue (call_id, held_reason, sla_due_at, assignee)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (call_id) WHERE status IN ('open', 'in_review') DO NOTHING
     RETURNING *`,
    [v.callId, v.heldReason, v.slaDueAt, v.assignee ?? null],
  );
  if (inserted[0]) return parseOrThrow(TABLE, reviewQueueRowSchema, inserted[0]);

  // Conflict: an active row already exists (possibly just committed by a concurrent tx). A new
  // statement's snapshot sees it.
  const existing = await query<ReviewQueueRow>(
    pool,
    `SELECT * FROM review_queue
      WHERE call_id = $1 AND status IN ('open', 'in_review')
      ORDER BY created_at
      LIMIT 1`,
    [v.callId],
  );
  if (existing[0]) return parseOrThrow(TABLE, reviewQueueRowSchema, existing[0]);

  // A conflict with no active row means the row was resolved between the two statements — a
  // genuine race/corruption, surfaced rather than silently returning nothing.
  throw new DalError(
    DAL_REVIEW_INVARIANT,
    `${DAL_REVIEW_INVARIANT}: enqueueReview hit a conflict but found no active review for ${v.callId}`,
    { table: TABLE, call_id: v.callId },
  );
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

/**
 * Whether a call has a CLOSED review row — one whose `status IN ('resolved','unresolvable')`
 * (Task 6.2, broadened from `unresolvable`-only). The runner's `review_closed` terminal guard
 * uses this to confirm a `review_closed` call_state genuinely has its matching closed review —
 * a stray `review_closed` with no closed review is corruption, not a completed transition
 * (Task 6.1 [V2]).
 *
 * Broadened because two review-surface action classes now move a held call to `review_closed`:
 * `mark_unresolvable` closes the review as `unresolvable`, while `reject` / `mark_spam` close it
 * as `resolved`. Both are legitimate closed reviews, so the guard must accept either — otherwise
 * a reconciliation/duplicate re-enqueue of a rejected/spam call would spuriously throw
 * "inconsistent" instead of no-op'ing. (The name is kept for its importers; conceptually it is
 * "has a closed review for this call".)
 */
export async function hasTerminalReviewForCall(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM review_queue
      WHERE call_id = $1 AND status IN ('resolved', 'unresolvable') LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Mark a held call UNRESOLVABLE — the review-surface action that gives up on a hold (Task 6.1).
 * One transaction moves BOTH records and writes the audit row, or none of it:
 *   1. lock the active review row(s) (`FOR UPDATE`, NO `LIMIT` so duplicate active rows aren't
 *      masked in a pre-migration-012 DB) and require EXACTLY one → `unresolvable` + `resolved_at`;
 *   2. move `call_state` `held` → `review_closed`, requiring EXACTLY one row (so a call no longer
 *      `held` fails rather than leaving a `review_closed` with no held origin);
 *   3. write the `mark_unresolvable` audit row, enlisted in this same transaction.
 * Any guard miss (no active review, duplicate active reviews, an already-terminal review, or a
 * `call_state` not `held`) rolls back and throws {@link DAL_REVIEW_INVARIANT} — no partial write,
 * no orphaned audit row. `actor` is required.
 */
export async function markUnresolvable(pool: Pool, callId: string, actor: string): Promise<void> {
  const normalizedActor = typeof actor === 'string' ? actor.trim() : '';
  if (normalizedActor.length === 0) {
    throw new DalError(
      DAL_VALIDATION_FAILED,
      `${DAL_VALIDATION_FAILED}: markUnresolvable requires a non-empty actor`,
      { table: TABLE, call_id: callId },
    );
  }

  await withTransaction(pool, async (client) => {
    const active = await query<{ id: string; status: string }>(
      client,
      `SELECT id, status FROM review_queue
        WHERE call_id = $1 AND status IN ('open', 'in_review')
        FOR UPDATE`,
      [callId],
    );
    if (active.length !== 1) {
      throw new DalError(
        DAL_REVIEW_INVARIANT,
        `${DAL_REVIEW_INVARIANT}: markUnresolvable expects exactly one active review for ${callId}, found ${active.length}`,
        { table: TABLE, call_id: callId },
      );
    }
    const review = active[0]!;

    await query(
      client,
      `UPDATE review_queue SET status = 'unresolvable', resolved_at = now() WHERE id = $1`,
      [review.id],
    );

    // Move call_state off `held` in the SAME tx — else the runner's held-terminal guard would
    // treat a resolved review with a still-`held` call_state as corruption. 'held'/'review_closed'
    // are SQL literals (like skipCall/holdCall) to avoid a db → pipeline layering dependency.
    const moved = await query<{ call_id: string }>(
      client,
      `UPDATE call_state SET status = 'review_closed', updated_at = now()
        WHERE call_id = $1 AND status = 'held'
        RETURNING call_id`,
      [callId],
    );
    if (moved.length !== 1) {
      throw new DalError(
        DAL_REVIEW_INVARIANT,
        `${DAL_REVIEW_INVARIANT}: markUnresolvable expected call_state ${callId} to be 'held', moved ${moved.length} rows`,
        { table: 'call_state', call_id: callId },
      );
    }

    await recordOperatorAction(client, {
      reviewQueueId: review.id,
      actor: normalizedActor,
      action: 'mark_unresolvable',
      before: { review_status: review.status, call_state_status: 'held' },
      after: { review_status: 'unresolvable', call_state_status: 'review_closed' },
    });
  });
}

/** The before/after state a review-id-scoped transition returns, for the caller's audit row. */
export interface ReviewTransition {
  reviewQueueId: string;
  callId: string;
  before: { review_status: string; call_state_status: string };
  after: { review_status: string; call_state_status: string };
}

/**
 * Review-ID-scoped `mark_unresolvable` transition (Task 6.2), enlisted in the caller's
 * transaction ({@link Queryable}). Locks the EXACT review row by id (`FOR UPDATE`), requires it
 * `open`/`in_review`, sets it `unresolvable` + `resolved_at` (+ assignee ← actor when null), and
 * moves the matching `call_state` `held` → `review_closed` (requiring exactly one row). Returns
 * the before/after state and does **NOT** write the `operator_actions` row — the generic
 * review-action handler writes the single audit row (with the `action_params` fingerprint +
 * idempotency), so `mark_unresolvable` yields exactly one audit row.
 *
 * Deliberately NOT the call-id-based {@link markUnresolvable}: a stale review id could otherwise
 * operate on a DIFFERENT active review for the same call. Locking by review id makes it exact.
 * Any guard miss (missing/terminal review, a `call_state` not `held`) throws
 * {@link DAL_REVIEW_INVARIANT} → the caller's tx rolls back → no partial write.
 */
export async function markUnresolvableByReviewId(
  db: Queryable,
  reviewQueueId: string,
  actor: string,
): Promise<ReviewTransition> {
  const locked = await query<{ id: string; status: string; call_id: string }>(
    db,
    `SELECT id, status, call_id FROM review_queue WHERE id = $1 FOR UPDATE`,
    [reviewQueueId],
  );
  const review = locked[0];
  if (!review || (review.status !== 'open' && review.status !== 'in_review')) {
    throw new DalError(
      DAL_REVIEW_INVARIANT,
      `${DAL_REVIEW_INVARIANT}: markUnresolvableByReviewId requires an active review ${reviewQueueId}, found ${review?.status ?? 'none'}`,
      { table: TABLE },
    );
  }

  await query(
    db,
    `UPDATE review_queue
        SET status = 'unresolvable', resolved_at = now(), assignee = COALESCE(assignee, $2)
      WHERE id = $1`,
    [reviewQueueId, actor],
  );

  const moved = await query<{ call_id: string }>(
    db,
    `UPDATE call_state SET status = 'review_closed', updated_at = now()
      WHERE call_id = $1 AND status = 'held'
      RETURNING call_id`,
    [review.call_id],
  );
  if (moved.length !== 1) {
    throw new DalError(
      DAL_REVIEW_INVARIANT,
      `${DAL_REVIEW_INVARIANT}: markUnresolvableByReviewId expected call_state ${review.call_id} to be 'held', moved ${moved.length} rows`,
      { table: 'call_state', call_id: review.call_id },
    );
  }

  return {
    reviewQueueId,
    callId: review.call_id,
    before: { review_status: review.status, call_state_status: 'held' },
    after: { review_status: 'unresolvable', call_state_status: 'review_closed' },
  };
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

/** One held-for-review count, per `held_reason` (Task 7.3 status surface). */
export interface HeldReasonCount {
  held_reason: string;
  count: number;
}

/**
 * Count active (open/in_review) held calls grouped by `held_reason` — the status surface's
 * held-for-review breakdown. Read-only aggregation; touches no content columns. An empty
 * result (no held calls) is a legitimate zero, distinct from a query failure the caller
 * surfaces as `unknown`.
 */
export async function countOpenByReason(pool: Pool): Promise<HeldReasonCount[]> {
  return query<HeldReasonCount>(
    pool,
    `SELECT held_reason::text AS held_reason, count(*)::int AS count
       FROM review_queue
      WHERE status IN ('open', 'in_review')
      GROUP BY held_reason
      ORDER BY held_reason`,
  );
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

// --- Held-raw retention contract (Task 6.1 ↔ Task 8.1) ---------------------------------------
//
// Task 6.1 defines the policy and leaves these hooks; the retention cron (Task 8.1) owns the
// actual raw/vault deletion (never inline in the per-call path). The cap is a MAXIMUM raw-PII
// retention limit, so on the cap the raw transcript + vault are HARD-purged (rendered
// unrecoverable) while the redacted clean transcript + this review row survive so review can
// still resolve/mark-unresolvable.

/**
 * The lean projection the held-cap purge needs from a review row (Task 8.1). Deliberately NOT
 * the full {@link ReviewQueueRow}: the retention cron runs as `purge_role`, which is granted
 * SELECT on ONLY these five columns (migration 013) — it must never read `assignee` /
 * `held_reason` / `sla_due_at`. A `SELECT *` here would fail with 42501 under that role.
 */
export interface RawPurgeCandidate {
  id: string;
  call_id: string;
  status: ReviewStatus;
  created_at: Date;
  raw_purged_at: Date | null;
}

/**
 * Review items whose held raw transcript + vault have exceeded the retention cap and must be
 * purged "regardless" of review status — INCLUDING `unresolvable` (the execution doc requires
 * an unresolvable item's raw to be purged on the cap). A `resolved` item is excluded: its raw
 * follows the normal retention window, not the held cap. Already-purged rows (`raw_purged_at`
 * set) are excluded so Task 8.1 never double-purges. Oldest first.
 *
 * Takes a {@link Queryable} so Task 8.1 runs it on the advisory-lock-holding client, and
 * projects only the {@link RawPurgeCandidate} columns so the narrow `purge_role` grant suffices.
 * An optional `limit` bounds the batch so the held-cap purge honors `RETENTION_PURGE_BATCH_SIZE`
 * (each processed row leaves the eligible set — `raw_purged_at` is stamped — so re-fetching
 * drains a backlog batch by batch).
 */
export async function listRawPurgeEligible(
  db: Queryable,
  capHours: number,
  now: Date,
  limit?: number,
): Promise<RawPurgeCandidate[]> {
  return query<RawPurgeCandidate>(
    db,
    `SELECT id, call_id, status, created_at, raw_purged_at FROM review_queue
      WHERE status IN ('open', 'in_review', 'unresolvable')
        AND raw_purged_at IS NULL
        AND created_at + ($1 * interval '1 hour') < $2
      ORDER BY created_at
      ${limit === undefined ? '' : 'LIMIT $3'}`,
    limit === undefined ? [capHours, now] : [capHours, now, limit],
  );
}

/**
 * Count held-cap-eligible review items (same predicate as {@link listRawPurgeEligible}), for the
 * retention dry-run report — so reporting is exact without loading every candidate row.
 */
export async function countRawPurgeEligible(
  db: Queryable,
  capHours: number,
  now: Date,
): Promise<number> {
  const rows = await query<{ n: string }>(
    db,
    `SELECT count(*)::text AS n FROM review_queue
      WHERE status IN ('open', 'in_review', 'unresolvable')
        AND raw_purged_at IS NULL
        AND created_at + ($1 * interval '1 hour') < $2`,
    [capHours, now],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whether a call has a review that must BLOCK the normal raw/vault purge (Task 8.1). True while
 * a review row is `open`/`in_review`/`unresolvable` AND its raw has not already been cap-purged
 * (`raw_purged_at IS NULL`). Task 8.1's normal raw/vault purge must exclude such calls unless the
 * held-cap query itself selected them — this is the guarantee for ALL held calls, not the
 * incidental fact that a current-path hold leaves `retention_eligible_at` unstamped.
 */
export async function hasBlockingReviewForRawPurge(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM review_queue
      WHERE call_id = $1 AND status IN ('open', 'in_review', 'unresolvable')
        AND raw_purged_at IS NULL
      LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Whether a call has a review whose raw/vault were HELD-CAP PURGED (`raw_purged_at IS NOT
 * NULL`), Task 8.1 §6. The held-cap purge PHYSICALLY deletes raw/vault (no tombstone), so this
 * is the named predicate for "this call's raw is retention-final." The `putTranscript`/`putToken`
 * writers enforce it inline via a `NOT EXISTS` guarded insert; the redact/fetch preflight uses
 * this for an early, clear hold (defense-in-depth) before any partial write.
 */
export async function hasRawPurgedReview(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM review_queue WHERE call_id = $1 AND raw_purged_at IS NOT NULL LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Whether a call has a review that must BLOCK the normal clean-transcript purge (Task 8.1).
 * `clean_transcripts` IS purgeable, so its normal `retention_eligible_at` window could otherwise
 * delete redacted text a reviewer still needs. True while a review row is `open`/`in_review`/
 * `unresolvable` — `unresolvable` is included because its raw IS cap-purged "regardless", so its
 * redacted record must survive to keep the review resolvable/auditable. Unlike the raw-purge
 * predicate this does NOT clear once raw is purged: the clean transcript must outlive the raw.
 */
export async function hasBlockingReviewForCleanTranscript(
  pool: Pool,
  callId: string,
): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM review_queue
      WHERE call_id = $1 AND status IN ('open', 'in_review', 'unresolvable')
      LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Stamp `raw_purged_at` on a review row (DB-A), the Task 6.1 ↔ 8.1 seam. Takes a {@link Queryable}
 * so the retention cron calls it on the DB-A `purge_role` client. Under the two-pool split (ADR
 * 0008 Move 2) raw/vault live in DB-B and cannot share a transaction with this DB-A write, so the
 * held-cap purge deletes raw/vault + writes the DB-B `raw_purge_tombstone` in ONE DB-B transaction
 * FIRST, then calls this as a SEPARATE DB-A write AFTER that commit — a best-effort audit mirror of
 * the DB-B tombstone (which is the authoritative finality). Idempotent (`raw_purged_at IS NULL`
 * guard): if a crash lands between the DB-B commit and this stamp, a later run re-runs it and it
 * converges. `review_queue` is NOT purgeable and has no retention triplet, so the row survives.
 *
 * `RETURNING id` (not `*`): the caller only needs to know whether the stamp landed (the purged
 * id) or was a no-op (`undefined`, already purged), and `purge_role` may not read the full row.
 */
export async function markRawPurged(
  db: Queryable,
  id: string,
  now: Date,
): Promise<string | undefined> {
  const rows = await query<{ id: string }>(
    db,
    `UPDATE review_queue SET raw_purged_at = $2
      WHERE id = $1 AND raw_purged_at IS NULL
      RETURNING id`,
    [id, now],
  );
  return rows[0]?.id;
}
