import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type InsertRejectionInput,
  type LabeledExampleRejectionRow,
  insertRejectionSchema,
  labeledExampleRejectionRowSchema,
} from '../schemas/labeled-example-rejections.js';

const TABLE = 'labeled_example_rejections';

/**
 * Insert one CONTENT-FREE rejection (Task 6.3). Version-scoped idempotent (`ON CONFLICT DO
 * NOTHING`) so a repeated sync of the same failing candidate under the same versions writes no
 * duplicate — a conflict returns `undefined`, a fresh insert returns the row. Accepts a
 * {@link Queryable}. The counts-shape invariant is enforced by the insert schema AND the DB CHECK.
 */
export async function insertRejection(
  db: Queryable,
  input: InsertRejectionInput,
): Promise<LabeledExampleRejectionRow | undefined> {
  const v = parseOrThrow(TABLE, insertRejectionSchema, input);
  const rows = await query<LabeledExampleRejectionRow>(
    db,
    `INSERT INTO labeled_example_rejections
       (operator_action_id, task_type, review_queue_id, call_id, held_reason,
        rejection_reason, rejection_counts, eval_set_version, pii_gate_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (operator_action_id, task_type, pii_gate_version, eval_set_version) DO NOTHING
     RETURNING *`,
    [
      v.operatorActionId,
      v.taskType,
      v.reviewQueueId,
      v.callId,
      v.heldReason,
      v.rejectionReason,
      toJsonParam(v.rejectionCounts),
      v.evalSetVersion,
      v.piiGateVersion,
    ],
  );
  return rows[0] ? parseOrThrow(TABLE, labeledExampleRejectionRowSchema, rows[0]) : undefined;
}
