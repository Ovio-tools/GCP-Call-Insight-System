import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  DAL_RESTRICTED_ACCESS_DENIED,
  DalError,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  sqlState,
} from './errors.js';
import type { Queryable } from './types.js';

/**
 * Run a parameterized query and return its rows. Maps a Postgres `insufficient_privilege`
 * (42501) — the signal that a role touched a table it isn't granted — to a
 * {@link DalError} with a stable code; every other error propagates unchanged so the
 * original pg diagnostics survive.
 */
export async function query<R extends QueryResultRow>(
  q: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  try {
    const res = await q.query<R>(text, params);
    return res.rows;
  } catch (err) {
    if (sqlState(err) === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      throw new DalError(
        DAL_RESTRICTED_ACCESS_DENIED,
        `${DAL_RESTRICTED_ACCESS_DENIED}: query denied by role grants`,
        { sqlstate: SQLSTATE_INSUFFICIENT_PRIVILEGE },
      );
    }
    throw err;
  }
}

/**
 * Serialize a value for a `jsonb` parameter. node-pg turns a JS array into a Postgres
 * ARRAY literal, not JSON, so jsonb params must be stringified and the placeholder cast
 * `$n::jsonb`. `null`/`undefined` become SQL NULL.
 */
export function toJsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Run `fn` inside a single transaction on one pooled connection: BEGIN, run, COMMIT;
 * ROLLBACK on any throw; release the client in `finally` so it can never leak. The
 * rollback error is swallowed (the original error is what matters) but the original
 * always propagates.
 *
 * Used by every helper that must be atomic — the stage-advance (UPDATE + processing_log
 * in one commit), the idempotent review enqueue, and the restricted-role context.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
