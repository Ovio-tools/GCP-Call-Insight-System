import type { RecentCall } from '../dialpad/client/index.js';

/**
 * Conclusion-time window membership for the backfill scan (Task 11.2, §2). The window `[from, to]`
 * means "calls that CONCLUDED in `[from, to]`", mirroring reconciliation's compensation.
 */

/** States that POSITIVELY mean the call has not concluded yet — the same fail-open vocabulary the
 * reconciliation sweep uses. Anything else (unknown/absent) is NOT treated as active. */
const NON_TERMINAL_CALL_STATES: ReadonlySet<string> = new Set([
  'active',
  'in_progress',
  'ringing',
  'queued',
]);

export interface WindowBounds {
  fromMs: number;
  toMs: number;
}

/**
 * The `started_after` floor for the list query: `from - maxCall` (Dialpad's list API filters by
 * START time only, so a long call that started before `from` but concluded inside it is still
 * listed). Over-listing is harmless — anything out-of-window is skipped by {@link callMembership},
 * anything already ingested is skipped idempotently.
 */
export function computeSince(fromMs: number, maxCallMinutes: number): number {
  return fromMs - maxCallMinutes * 60_000;
}

/**
 * Whether a listed call belongs in this backfill window. Most-reliable signal first:
 *  - a parseable `endedAt` → include iff it concluded inside `[from, to]`;
 *  - no `endedAt` but a recognised in-progress state → skip (not concluded yet);
 *  - no `endedAt`, not recognised-active → fail OPEN only within a bounded start window: include iff
 *    `startedAt <= to`; a call with `startedAt > to` (and no end) is above-window and skipped.
 *
 * `startedAt` is REQUIRED on every listed item and validated per page BEFORE membership runs (see
 * `pageStartedAtFailure`); the `startedAt === undefined` branch here is a defensive skip only.
 */
export function callMembership(call: RecentCall, bounds: WindowBounds): 'include' | 'skip' {
  if (call.endedAt !== undefined) {
    return call.endedAt >= bounds.fromMs && call.endedAt <= bounds.toMs ? 'include' : 'skip';
  }
  const state = call.state?.toLowerCase();
  if (state !== undefined && NON_TERMINAL_CALL_STATES.has(state)) return 'skip';
  if (call.startedAt !== undefined && call.startedAt <= bounds.toMs) return 'include';
  return 'skip';
}
