import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type OperatorActionRow,
  type RecordOperatorActionInput,
  operatorActionRowSchema,
  recordOperatorActionInputSchema,
} from '../schemas/operator-actions.js';

const TABLE = 'operator_actions';

/**
 * Record an operator action with before/after JSON snapshots (the audit trail for the
 * review surface). Append-only — every action is its own immutable row. Accepts a
 * {@link Queryable} so a state-changing review action (e.g. `markUnresolvable`, Task 6.1) can
 * enlist the audit insert in the SAME transaction as the state change — no partial write, no
 * orphaned audit row.
 */
export async function recordOperatorAction(
  db: Queryable,
  input: RecordOperatorActionInput,
): Promise<OperatorActionRow> {
  const v = parseOrThrow(TABLE, recordOperatorActionInputSchema, input);
  const rows = await query<OperatorActionRow>(
    db,
    `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [v.reviewQueueId, v.actor, v.action, toJsonParam(v.before), toJsonParam(v.after)],
  );
  return parseOrThrow(TABLE, operatorActionRowSchema, rows[0]);
}

export async function listByReview(
  pool: Pool,
  reviewQueueId: string,
): Promise<OperatorActionRow[]> {
  const rows = await query<OperatorActionRow>(
    pool,
    `SELECT * FROM operator_actions WHERE review_queue_id = $1 ORDER BY created_at`,
    [reviewQueueId],
  );
  return rows.map((r) => parseOrThrow(TABLE, operatorActionRowSchema, r));
}
