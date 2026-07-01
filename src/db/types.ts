import { z } from 'zod';
import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal surface both `pg.Pool` and `pg.PoolClient` satisfy. Repositories accept a
 * `Queryable` so a caller can pass a pool for a one-shot query or a client to enlist
 * the query in an open transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** A JSON value, for `jsonb` columns whose shape isn't otherwise constrained. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
