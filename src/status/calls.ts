import type { Pool } from 'pg';

/**
 * Per-call pipeline outcome view (companion to the status funnel). Reads `call_state` — the
 * per-call state machine — so it can show EVERY call and where it ended up, including the ones
 * the knowledge base intentionally omits (non-customer, spam, filtered junk, still-processing).
 *
 * PII boundary: this module SELECTs only the state-machine columns (call_id, status,
 * current_stage, drop_reason, timestamps) plus the enum `held_reason`. It NEVER reads
 * `call_state.source_metadata` (which can carry raw call metadata), and the pipeline stores no
 * transcript content in `call_state` at all. So the view is de-identified by construction.
 */

export type CallOutcomeKey =
  | 'processing'
  | 'customer_completed'
  | 'non_customer'
  | 'spam'
  | 'filtered'
  | 'held'
  | 'review_closed';

export interface CallOutcome {
  key: CallOutcomeKey;
  /** Short human label for the badge, e.g. "Non-customer". */
  label: string;
  /** Humanized detail (the drop/held reason) when useful, else null. */
  reason: string | null;
}

/** snake_case enum → "Sentence case" for display. Null passes through. */
function humanize(value: string | null): string | null {
  if (!value) return null;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Fold the raw state machine (`status` + `drop_reason` + latest `held_reason`) into a single
 * human outcome. Total and defensive: an unrecognized status degrades to `processing` rather
 * than throwing, so a future status value can never break the page.
 */
export function deriveOutcome(
  status: string,
  dropReason: string | null,
  heldReason: string | null,
): CallOutcome {
  switch (status) {
    case 'completed':
      return { key: 'customer_completed', label: 'Customer', reason: null };
    case 'skipped':
      if (dropReason === 'classified_non_customer') {
        return { key: 'non_customer', label: 'Non-customer', reason: null };
      }
      return { key: 'filtered', label: 'Filtered', reason: humanize(dropReason) };
    case 'held':
      if (heldReason === 'classified_spam') {
        return { key: 'spam', label: 'Spam', reason: null };
      }
      return { key: 'held', label: 'Held', reason: humanize(heldReason) };
    case 'review_closed':
      return { key: 'review_closed', label: 'Review closed', reason: humanize(heldReason) };
    case 'processing':
    default:
      return { key: 'processing', label: 'Processing', reason: null };
  }
}

/** The outcome filter options rendered in the dropdown, in display order. */
export const OUTCOME_FILTERS = [
  { key: 'all', label: 'All calls' },
  { key: 'customer', label: 'Customer (completed)' },
  { key: 'non_customer', label: 'Non-customer' },
  { key: 'spam', label: 'Spam' },
  { key: 'filtered', label: 'Filtered (junk)' },
  { key: 'held', label: 'Held for review' },
  { key: 'processing', label: 'Processing' },
] as const;

/**
 * The SQL predicate for a filter key, or null for "all"/undefined/unknown. The predicates use
 * ONLY fixed enum literals (never request data), and the key itself is matched against this
 * closed switch, so an injected value falls through to `null` (no filter) — never into SQL.
 */
export function outcomeWhereClause(filter: string | undefined): string | null {
  switch (filter) {
    case 'customer':
      return "cs.status = 'completed'";
    case 'non_customer':
      return "cs.status = 'skipped' AND cs.drop_reason = 'classified_non_customer'";
    case 'spam':
      return "rq.held_reason = 'classified_spam'";
    case 'filtered':
      return "cs.status = 'skipped' AND cs.drop_reason IS DISTINCT FROM 'classified_non_customer'";
    case 'held':
      return "cs.status = 'held' AND rq.held_reason IS DISTINCT FROM 'classified_spam'";
    case 'processing':
      return "cs.status = 'processing'";
    default:
      return null;
  }
}

export interface CallListItem {
  call_id: string;
  status: string;
  current_stage: string;
  created_at: string;
  updated_at: string;
  outcome: CallOutcome;
}

export interface CallsPage {
  items: CallListItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  filter: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface CallStateRow {
  call_id: string;
  status: string;
  current_stage: string;
  drop_reason: string | null;
  held_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The latest held_reason per call is joined via a LATERAL subquery so the `spam`/`held` filters
 * (and the badge detail) can reference it. Ordered newest-first, paginated. `total` is the
 * count under the same filter for the pager.
 */
export async function listCalls(
  pool: Pool,
  opts: { filter?: string; page?: number; pageSize?: number } = {},
): Promise<CallsPage> {
  const filterKey = OUTCOME_FILTERS.some((f) => f.key === opts.filter) ? opts.filter! : 'all';
  const where = outcomeWhereClause(filterKey);
  const whereSql = where ? `WHERE ${where}` : '';
  const pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(opts.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const lateral =
    'LEFT JOIN LATERAL (SELECT held_reason FROM review_queue rq2 ' +
    'WHERE rq2.call_id = cs.call_id ORDER BY rq2.created_at DESC LIMIT 1) rq ON true';

  const countRes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM call_state cs ${lateral} ${whereSql}`,
  );
  const total = countRes.rows[0]?.n ?? 0;

  const rowsRes = await pool.query<CallStateRow>(
    `SELECT cs.call_id, cs.status, cs.current_stage, cs.drop_reason, cs.created_at, cs.updated_at,
            rq.held_reason
       FROM call_state cs ${lateral} ${whereSql}
      ORDER BY cs.created_at DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, offset],
  );

  const items: CallListItem[] = rowsRes.rows.map((r) => ({
    call_id: r.call_id,
    status: r.status,
    current_stage: r.current_stage,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    outcome: deriveOutcome(r.status, r.drop_reason, r.held_reason),
  }));

  return {
    items,
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(Math.ceil(total / pageSize), 1),
    filter: filterKey,
  };
}
