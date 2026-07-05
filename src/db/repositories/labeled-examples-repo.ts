import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../../evaluation/version.js';
import {
  type InsertLabeledExampleInput,
  type LabeledExampleRow,
  insertLabeledExampleSchema,
  labeledExampleRowSchema,
} from '../schemas/labeled-examples.js';

const TABLE = 'labeled_examples';

/**
 * Insert one ACCEPTED label (Task 6.3). Version-scoped idempotent: `ON CONFLICT DO NOTHING` on
 * `(operator_action_id, task_type, pii_gate_version, eval_set_version)` so a re-run / concurrent
 * sync writes no duplicate — a conflict returns `undefined`, a fresh insert returns the row.
 * Accepts a {@link Queryable} so a caller may enlist it in a transaction if desired.
 */
export async function insertLabeledExample(
  db: Queryable,
  input: InsertLabeledExampleInput,
): Promise<LabeledExampleRow | undefined> {
  const v = parseOrThrow(TABLE, insertLabeledExampleSchema, input);
  const rows = await query<LabeledExampleRow>(
    db,
    `INSERT INTO labeled_examples
       (operator_action_id, task_type, review_queue_id, call_id, held_reason, reviewer_actor,
        redacted_input, expected_output, source_prompt_version, prompt_version_source,
        source_schema_version, model_id, model_id_source, eval_set_version, pii_gate_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (operator_action_id, task_type, pii_gate_version, eval_set_version) DO NOTHING
     RETURNING *`,
    [
      v.operatorActionId,
      v.taskType,
      v.reviewQueueId,
      v.callId,
      v.heldReason,
      v.reviewerActor,
      v.redactedInput,
      toJsonParam(v.expectedOutput),
      v.sourcePromptVersion,
      v.promptVersionSource,
      v.sourceSchemaVersion ?? null,
      v.modelId ?? null,
      v.modelIdSource,
      v.evalSetVersion,
      v.piiGateVersion,
    ],
  );
  return rows[0] ? parseOrThrow(TABLE, labeledExampleRowSchema, rows[0]) : undefined;
}

/**
 * List accepted labels for one version set, oldest first. Defaults to the CURRENT
 * `EVAL_SET_VERSION` + `PII_GATE_VERSION` (finding R2-1) — export and the eval runner read only the
 * current-version corpus, so an old-version accepted row never leaks into a new-version run.
 */
export async function listAcceptedExamples(
  pool: Pool,
  opts: { evalSetVersion?: number; piiGateVersion?: number } = {},
): Promise<LabeledExampleRow[]> {
  const evalSetVersion = opts.evalSetVersion ?? EVAL_SET_VERSION;
  const piiGateVersion = opts.piiGateVersion ?? PII_GATE_VERSION;
  const rows = await query<LabeledExampleRow>(
    pool,
    `SELECT * FROM labeled_examples
      WHERE eval_set_version = $1 AND pii_gate_version = $2
      ORDER BY created_at, id`,
    [evalSetVersion, piiGateVersion],
  );
  return rows.map((r) => parseOrThrow(TABLE, labeledExampleRowSchema, r));
}
