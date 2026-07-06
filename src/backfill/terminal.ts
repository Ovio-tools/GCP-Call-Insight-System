import { query } from '../db/sql.js';
import type { Queryable } from '../db/types.js';
import { UPSERT_PROTECTED_CALL_STATE_STATUSES } from '../db/enums.js';

/**
 * Terminal-based completion for the backfill drain phase (Task 11.2, §1). A tracked call is
 * TERMINAL once its `call_state.status` reaches a resting/set-aside state OR it has been
 * dead-lettered.
 *
 * The terminal `call_state` statuses are exactly the upsert-protected ones
 * (`completed`/`skipped`/`held`/`review_closed`) — the states a duplicate ingestion must never
 * reseed — which is the same set of "no longer in flight" statuses the drain waits on. Reusing that
 * db-layer constant keeps the two vocabularies from drifting.
 *
 * Documented caveat (§1): a call whose transcript is not yet available legitimately stays
 * non-terminal (`processing`) and keeps the run active until it is; operators backfill concluded
 * historical calls whose transcripts exist, and `BACKFILL_STALL_THRESHOLD_MS` is generous.
 */
export const TERMINAL_CALL_STATE_STATUSES = UPSERT_PROTECTED_CALL_STATE_STATUSES;

/** Pure predicate: is this call terminal given its status and whether it has been dead-lettered? */
export function isCallTerminal(status: string, hasDeadLetter: boolean): boolean {
  return hasDeadLetter || (TERMINAL_CALL_STATE_STATUSES as readonly string[]).includes(status);
}

/**
 * Count the tracked calls for a run that are NOT yet terminal — the drain phase's poll. Zero means
 * every seeded/rescued call reached a terminal `call_state` (or was dead-lettered), and only then is
 * the terminal success ping sent. A tracked call with a missing `call_state` row (should not happen —
 * seeding precedes tracking) is COALESCE'd to non-terminal so the drain never completes early on it.
 */
export async function countNonTerminalTrackedCalls(db: Queryable, runId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    db,
    `SELECT count(*)::int AS count
       FROM backfill_run_calls brc
       LEFT JOIN call_state cs ON cs.call_id = brc.call_id
      WHERE brc.backfill_run_id = $1
        AND NOT (
          COALESCE(cs.status = ANY($2), false)
          OR EXISTS (SELECT 1 FROM dead_letter dl WHERE dl.call_id = brc.call_id)
        )`,
    [runId, [...TERMINAL_CALL_STATE_STATUSES]],
  );
  return rows[0]?.count ?? 0;
}
