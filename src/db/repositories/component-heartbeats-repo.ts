import type { Pool } from 'pg';
import { assertNoContentFields } from '../../logging/redaction.js';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type ComponentHeartbeatRow,
  type RecordHeartbeatInput,
  componentHeartbeatRowSchema,
  recordHeartbeatInputSchema,
} from '../schemas/component-heartbeats.js';

const TABLE = 'component_heartbeats';

/**
 * Record a component's successful periodic tick (Task 7.3), upserting the single row keyed on
 * `component` so `last_run_at` always reflects the most recent success. Stamps `last_run_at`
 * in the database (`now()`), never from an application clock, so the status surface's
 * staleness math is against real DB time.
 *
 * This is a BEST-EFFORT mirror: the caller wraps it so a failure is sanitized-log-only and
 * never blocks the authoritative external ping nor fails the run. `detail` is content-field
 * guarded here — a known content/PII key throws {@link RedactionError} before the write, so a
 * leak fails loudly rather than persisting — matching the logger's no-PII contract.
 */
export async function recordHeartbeat(
  pool: Pool,
  input: RecordHeartbeatInput,
): Promise<ComponentHeartbeatRow> {
  const v = parseOrThrow(TABLE, recordHeartbeatInputSchema, input);
  // Counts only, never customer data — refuse a known content field before it is persisted.
  assertNoContentFields(v.detail ?? {});
  const rows = await query<ComponentHeartbeatRow>(
    pool,
    `INSERT INTO component_heartbeats (component, last_run_at, last_status, detail)
     VALUES ($1, now(), $2, COALESCE($3::jsonb, '{}'::jsonb))
     ON CONFLICT (component) DO UPDATE SET
       last_run_at = now(),
       last_status = EXCLUDED.last_status,
       detail = EXCLUDED.detail,
       updated_at = now()
     RETURNING *`,
    [v.component, v.status, toJsonParam(v.detail)],
  );
  return parseOrThrow(TABLE, componentHeartbeatRowSchema, rows[0]);
}

/** Every recorded component heartbeat. The status aggregator maps these onto the fixed
 * component list, rendering `unknown` for any component without a row. */
export async function listHeartbeats(pool: Pool): Promise<ComponentHeartbeatRow[]> {
  const rows = await query<ComponentHeartbeatRow>(
    pool,
    `SELECT * FROM component_heartbeats ORDER BY component`,
  );
  return rows.map((r) => parseOrThrow(TABLE, componentHeartbeatRowSchema, r));
}
