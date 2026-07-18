import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import type { CallIntent, ServiceCategory, Urgency } from '../enums.js';
import {
  type StructuredKnowledgeInsert,
  type StructuredKnowledgeRow,
  structuredKnowledgeInsertSchema,
  structuredKnowledgeRowSchema,
} from '../schemas/structured-knowledge.js';

const TABLE = 'structured_knowledge';

/** Idempotent upsert keyed on call_id — the durable extracted record for a call. */
export async function upsertStructuredKnowledge(
  pool: Pool,
  input: StructuredKnowledgeInsert,
): Promise<StructuredKnowledgeRow> {
  const v = parseOrThrow(TABLE, structuredKnowledgeInsertSchema, input);
  const rows = await query<StructuredKnowledgeRow>(
    pool,
    `INSERT INTO structured_knowledge (
       call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
       location_in_home, access_or_scheduling_notes, prior_attempts, urgency, concerns,
       sentiment, acquisition_source, competitor_mentions, schema_version, prompt_version, model_id)
     VALUES (
       $1, $2, $3, $4, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6::jsonb, '[]'::jsonb),
       $7, $8, $9, $10, COALESCE($11::jsonb, '[]'::jsonb),
       $12, $13, COALESCE($14::jsonb, '[]'::jsonb), $15, $16, $17)
     ON CONFLICT (call_id) DO UPDATE SET
       call_intent = EXCLUDED.call_intent,
       service_category = EXCLUDED.service_category,
       problem_statement = EXCLUDED.problem_statement,
       symptoms = EXCLUDED.symptoms,
       customer_language = EXCLUDED.customer_language,
       location_in_home = EXCLUDED.location_in_home,
       access_or_scheduling_notes = EXCLUDED.access_or_scheduling_notes,
       prior_attempts = EXCLUDED.prior_attempts,
       urgency = EXCLUDED.urgency,
       concerns = EXCLUDED.concerns,
       sentiment = EXCLUDED.sentiment,
       acquisition_source = EXCLUDED.acquisition_source,
       competitor_mentions = EXCLUDED.competitor_mentions,
       schema_version = EXCLUDED.schema_version,
       prompt_version = EXCLUDED.prompt_version,
       model_id = EXCLUDED.model_id
     RETURNING *`,
    [
      v.callId,
      v.callIntent,
      v.serviceCategory,
      v.problemStatement ?? null,
      toJsonParam(v.symptoms),
      toJsonParam(v.customerLanguage),
      v.locationInHome ?? null,
      v.accessOrSchedulingNotes ?? null,
      v.priorAttempts ?? null,
      v.urgency,
      toJsonParam(v.concerns),
      v.sentiment,
      v.acquisitionSource ?? null,
      toJsonParam(v.competitorMentions),
      v.schemaVersion,
      v.promptVersion,
      v.modelId,
    ],
  );
  return parseOrThrow(TABLE, structuredKnowledgeRowSchema, rows[0]);
}

export async function getStructuredKnowledge(
  pool: Pool,
  callId: string,
): Promise<StructuredKnowledgeRow | undefined> {
  const rows = await query<StructuredKnowledgeRow>(
    pool,
    `SELECT * FROM structured_knowledge WHERE call_id = $1`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, structuredKnowledgeRowSchema, rows[0]) : undefined;
}

// --- Knowledge-base surface read model (Task 10.1) ---
//
// Read-only, parameterized queries for the authenticated knowledge surface. An EXPLICIT column
// allowlist (never a wildcard column select) — and `sentiment` / `model_id` / `schema_version` /
// `prompt_version` are never selected, so internal-only fields and model metadata cannot egress.
// Free text is `ILIKE` (acceptable for a minimal internal tool). All filters go through the single
// {@link buildWhere} so a view and an export for the same filters select the same underlying set.

/** The allowlisted read columns (order = the CSV header / DTO order). NO `sentiment`, NO model
 * metadata. */
const READ_COLS =
  'call_id, created_at, call_intent, service_category, urgency, problem_statement, symptoms, ' +
  'customer_language, concerns, competitor_mentions, acquisition_source, location_in_home, ' +
  'access_or_scheduling_notes, prior_attempts';

/** One knowledge row as PG returns it (timestamptz → Date; jsonb arrays → parsed arrays). */
export interface KnowledgeReadRow {
  call_id: string;
  created_at: Date;
  call_intent: string;
  service_category: string;
  urgency: string;
  problem_statement: string | null;
  symptoms: string[];
  customer_language: string[];
  concerns: string[];
  competitor_mentions: string[];
  acquisition_source: string | null;
  location_in_home: string | null;
  access_or_scheduling_notes: string | null;
  prior_attempts: string | null;
}

/** The repo's parameterized filter contract. Date bounds are pre-resolved UTC instants (the
 * date-only / offset-less rules live in `src/knowledge/query.ts`). */
export interface KnowledgeQueryFilters {
  q?: string;
  serviceCategory?: ServiceCategory;
  callIntent?: CallIntent;
  urgency?: Urgency;
  fromInclusive?: Date;
  toExclusive?: Date;
}

/** Escape LIKE wildcards so user free-text can't inject `%`/`_` patterns; `\` is the ESCAPE char. */
function likeParam(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Build the shared WHERE clause + ordered params. `$1..$n` positional; no string interpolation of
 * values. */
function buildWhere(filters: KnowledgeQueryFilters): { clause: string; params: unknown[] } {
  // Superseded (duplicate-leg) rows are always hidden from the KB read model.
  const clauses: string[] = ['superseded_by_call_id IS NULL'];
  const params: unknown[] = [];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    clauses.push(sql(params.length));
  };

  if (filters.serviceCategory !== undefined)
    add((n) => `service_category = $${n}`, filters.serviceCategory);
  if (filters.callIntent !== undefined) add((n) => `call_intent = $${n}`, filters.callIntent);
  if (filters.urgency !== undefined) add((n) => `urgency = $${n}`, filters.urgency);
  if (filters.fromInclusive !== undefined) add((n) => `created_at >= $${n}`, filters.fromInclusive);
  if (filters.toExclusive !== undefined) add((n) => `created_at < $${n}`, filters.toExclusive);
  if (filters.q !== undefined && filters.q.length > 0) {
    params.push(likeParam(filters.q));
    const n = params.length;
    clauses.push(
      `(problem_statement ILIKE $${n} ESCAPE '\\' OR EXISTS (` +
        `SELECT 1 FROM jsonb_array_elements_text(customer_language) e WHERE e ILIKE $${n} ESCAPE '\\'))`,
    );
  }

  const clause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { clause, params };
}

/** One page of matching rows, deterministically ordered. */
export async function searchStructuredKnowledge(
  q: Queryable,
  filters: KnowledgeQueryFilters,
  page: { limit: number; offset: number },
): Promise<KnowledgeReadRow[]> {
  const { clause, params } = buildWhere(filters);
  const limitPos = params.length + 1;
  const offsetPos = params.length + 2;
  return query<KnowledgeReadRow>(
    q,
    `SELECT ${READ_COLS} FROM structured_knowledge ${clause}
     ORDER BY created_at DESC, call_id DESC
     LIMIT $${limitPos} OFFSET $${offsetPos}`,
    [...params, page.limit, page.offset],
  );
}

/** Total count for the same filters — pagination + truncation math. */
export async function countStructuredKnowledge(
  q: Queryable,
  filters: KnowledgeQueryFilters,
): Promise<number> {
  const { clause, params } = buildWhere(filters);
  const rows = await query<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM structured_knowledge ${clause}`,
    params,
  );
  return rows[0]?.n ?? 0;
}

/** All rows matching the filters, ordered, fetching `cap + 1` so the caller can detect truncation. */
export async function listStructuredKnowledgeForExport(
  q: Queryable,
  filters: KnowledgeQueryFilters,
  opts: { cap: number },
): Promise<KnowledgeReadRow[]> {
  const { clause, params } = buildWhere(filters);
  const limitPos = params.length + 1;
  return query<KnowledgeReadRow>(
    q,
    `SELECT ${READ_COLS} FROM structured_knowledge ${clause}
     ORDER BY created_at DESC, call_id DESC
     LIMIT $${limitPos}`,
    [...params, opts.cap + 1],
  );
}

export interface KnowledgeAggregate {
  total: number;
  minCreatedAt: Date | null;
  maxCreatedAt: Date | null;
  byServiceCategory: { key: string; count: number }[];
  byCallIntent: { key: string; count: number }[];
  byUrgency: { key: string; count: number }[];
}

/** Aggregate over the SAME WHERE, no pagination — feeds the summary so it reflects the whole
 * filtered set, never one page. */
export async function aggregateStructuredKnowledge(
  q: Queryable,
  filters: KnowledgeQueryFilters,
): Promise<KnowledgeAggregate> {
  const { clause, params } = buildWhere(filters);
  const totals = await query<{
    total: number;
    min_created_at: Date | null;
    max_created_at: Date | null;
  }>(
    q,
    `SELECT count(*)::int AS total, min(created_at) AS min_created_at, max(created_at) AS max_created_at
     FROM structured_knowledge ${clause}`,
    params,
  );
  const groupBy = async (column: 'service_category' | 'call_intent' | 'urgency') =>
    query<{ key: string; count: number }>(
      q,
      `SELECT ${column} AS key, count(*)::int AS count FROM structured_knowledge ${clause}
       GROUP BY ${column} ORDER BY count DESC, ${column} ASC`,
      params,
    );

  return {
    total: totals[0]?.total ?? 0,
    minCreatedAt: totals[0]?.min_created_at ?? null,
    maxCreatedAt: totals[0]?.max_created_at ?? null,
    byServiceCategory: await groupBy('service_category'),
    byCallIntent: await groupBy('call_intent'),
    byUrgency: await groupBy('urgency'),
  };
}

/** Retire a duplicate call-leg row by pointing it at the canonical call it duplicates.
 * Idempotent: only writes a row that is not already superseded. Returns rows affected. */
export async function setStructuredKnowledgeSuperseded(
  q: Queryable,
  input: { callId: string; canonicalCallId: string },
): Promise<number> {
  const rows = await query<{ call_id: string }>(
    q,
    `UPDATE structured_knowledge
       SET superseded_by_call_id = $2
     WHERE call_id = $1 AND call_id <> $2 AND superseded_by_call_id IS NULL
     RETURNING call_id`,
    [input.callId, input.canonicalCallId],
  );
  return rows.length;
}

/** One page of KB call_ids (newest first) that are NOT yet superseded — drives the cleanup
 *  one-off. `cursor` is the last row of the previous page (exclusive), a COMPOSITE keyset over
 *  `(created_at, call_id)` so rows sharing an identical `created_at` (batch inserts default to a
 *  transaction-fixed `now()`) are never silently skipped at a page boundary. */
export async function listKnowledgeCallIdsPage(
  q: Queryable,
  opts: { cursor?: { createdAt: Date; callId: string }; limit: number },
): Promise<{ call_id: string; created_at: Date }[]> {
  const params: unknown[] = [];
  let where = 'superseded_by_call_id IS NULL';
  if (opts.cursor !== undefined) {
    params.push(opts.cursor.createdAt, opts.cursor.callId);
    // Composite keyset matching ORDER BY (created_at DESC, call_id DESC).
    where += ` AND (created_at < $1 OR (created_at = $1 AND call_id < $2))`;
  }
  params.push(opts.limit);
  return query<{ call_id: string; created_at: Date }>(
    q,
    `SELECT call_id, created_at FROM structured_knowledge
     WHERE ${where}
     ORDER BY created_at DESC, call_id DESC
     LIMIT $${params.length}`,
    params,
  );
}
