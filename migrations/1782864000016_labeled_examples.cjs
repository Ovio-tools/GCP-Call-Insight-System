'use strict';

/**
 * Migration 16 — the labeled-examples corpus (Task 6.3).
 *
 * Reviewed decisions in the 6.2 review surface (`operator_actions`) are mined asynchronously into
 * a durable, versioned, PII-free labeled corpus that feeds the golden-fixture parse suites and a
 * periodic accuracy check on the classify/extract model steps. Three tables:
 *
 *  - `labeled_examples` — ACCEPTED labels: redacted input (from `clean_transcripts`) + the
 *    corrected controlled-enum output (from `operator_actions.after.action_params`) + sanitized
 *    provenance. NEVER raw transcript text, vault values, or clear PII.
 *  - `labeled_example_rejections` — CONTENT-FREE failed validations (a PII-gate hit, an extract
 *    schema failure, or a purged/absent clean transcript), so a false-positive gate never
 *    permanently blocks a correction and a lost capture stays visible + idempotent.
 *  - `evaluation_reports` — PII-free grouped accuracy reports from the eval runner.
 *
 * Both label tables carry the SAME version-scoped key `UNIQUE(operator_action_id, task_type,
 * pii_gate_version, eval_set_version)`: bumping `PII_GATE_VERSION`/`EVAL_SET_VERSION` re-opens a
 * previously accepted OR rejected candidate for revalidation without mutating old-version rows.
 *
 * Grants mirror the append-only audit pattern (migration 5 / 15): app_role gets SELECT + INSERT,
 * never UPDATE, never DELETE — these tables are immutable derived assets and are NOT purged (a new
 * de-identified asset distinct from purgeable `clean_transcripts`; see ADR 0005). restricted_role
 * and purge_role get NOTHING (grants are explicit per-table).
 *
 * `down` reverses grants then drops all three tables (no cross-FKs among them).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const now = (pgm) => pgm.func('now()');
const uuid = (pgm) => pgm.func('gen_random_uuid()');

const EXAMPLES = 'labeled_examples';
const REJECTIONS = 'labeled_example_rejections';
const REPORTS = 'evaluation_reports';

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // --- labeled_examples: accepted labels + provenance. Immutable, not purged. ---
  pgm.createTable(EXAMPLES, {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    // The source audit row. RESTRICT: audit durability — nothing deletes an operator_action.
    operator_action_id: {
      type: 'uuid',
      notNull: true,
      references: 'operator_actions',
      onDelete: 'RESTRICT',
    },
    task_type: { type: 'text', notNull: true },
    review_queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'review_queue',
      onDelete: 'RESTRICT',
    },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    held_reason: { type: 'held_reason', notNull: true },
    reviewer_actor: { type: 'text', notNull: true },
    // The redacted transcript — already past the redaction privacy boundary + re-scanned by the
    // sync PII gate. NEVER raw text.
    redacted_input: { type: 'text', notNull: true },
    // {bucket} for classify, or the 4 corrected enums for extract. Controlled values, no free text.
    expected_output: { type: 'jsonb', notNull: true },
    source_prompt_version: { type: 'text', notNull: true },
    prompt_version_source: { type: 'text', notNull: true },
    // Extract only; NULL for classify labels.
    source_schema_version: { type: 'integer' },
    // From the selected model_invocation when present; NULL (with model_id_source='none') otherwise.
    model_id: { type: 'text' },
    model_id_source: { type: 'text', notNull: true },
    eval_set_version: { type: 'integer', notNull: true },
    pii_gate_version: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.addConstraint(EXAMPLES, `${EXAMPLES}_task_type_chk`, {
    check: "task_type IN ('classify', 'extract')",
  });
  pgm.addConstraint(EXAMPLES, `${EXAMPLES}_prompt_version_source_chk`, {
    check: "prompt_version_source IN ('model_invocations', 'current_constant', 'none')",
  });
  pgm.addConstraint(EXAMPLES, `${EXAMPLES}_model_id_source_chk`, {
    check: "model_id_source IN ('model_invocations', 'none')",
  });
  // Version-scoped idempotency: one accepted label per (action, task_type) PER gate/set version.
  pgm.addConstraint(EXAMPLES, `${EXAMPLES}_version_scoped_uniq`, {
    unique: ['operator_action_id', 'task_type', 'pii_gate_version', 'eval_set_version'],
  });
  pgm.createIndex(EXAMPLES, 'task_type', { name: `${EXAMPLES}_task_type_idx` });
  pgm.createIndex(EXAMPLES, 'call_id', { name: `${EXAMPLES}_call_id_idx` });

  // --- labeled_example_rejections: content-free failed validations. ---
  pgm.createTable(REJECTIONS, {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    operator_action_id: {
      type: 'uuid',
      notNull: true,
      references: 'operator_actions',
      onDelete: 'RESTRICT',
    },
    task_type: { type: 'text', notNull: true },
    review_queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'review_queue',
      onDelete: 'RESTRICT',
    },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    held_reason: { type: 'held_reason', notNull: true },
    rejection_reason: { type: 'text', notNull: true },
    // Residual-scan category→count map (closed vocab). NON-NULL only for a 'pii' rejection;
    // NULL for 'schema' / 'missing_clean' (no content, nothing to count). NO content columns.
    rejection_counts: { type: 'jsonb' },
    eval_set_version: { type: 'integer', notNull: true },
    pii_gate_version: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.addConstraint(REJECTIONS, `${REJECTIONS}_task_type_chk`, {
    check: "task_type IN ('classify', 'extract')",
  });
  pgm.addConstraint(REJECTIONS, `${REJECTIONS}_reason_chk`, {
    check: "rejection_reason IN ('pii', 'schema', 'missing_clean')",
  });
  // Counts present iff the rejection is a PII hit; absent for the content-free reasons.
  pgm.addConstraint(REJECTIONS, `${REJECTIONS}_counts_shape_chk`, {
    check:
      "(rejection_reason = 'pii' AND rejection_counts IS NOT NULL) OR " +
      "(rejection_reason IN ('schema', 'missing_clean') AND rejection_counts IS NULL)",
  });
  pgm.addConstraint(REJECTIONS, `${REJECTIONS}_version_scoped_uniq`, {
    unique: ['operator_action_id', 'task_type', 'pii_gate_version', 'eval_set_version'],
  });
  pgm.createIndex(REJECTIONS, 'call_id', { name: `${REJECTIONS}_call_id_idx` });

  // --- evaluation_reports: PII-free grouped accuracy reports. ---
  pgm.createTable(REPORTS, {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    eval_set_version: { type: 'integer', notNull: true },
    pii_gate_version: { type: 'integer', notNull: true },
    // Only 'live' is the authoritative periodic accuracy check; 'test_stub' is non-authoritative.
    // 'dry_run' is a CLI preview that persists NOTHING, so it is NOT a value here.
    mode: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    skip_reason: { type: 'text', notNull: true },
    generated_at: { type: 'timestamptz', notNull: true },
    // Grouped counts only — no transcript, no free text.
    summary: { type: 'jsonb', notNull: true, default: '{}' },
    // Bounded sample: ids/enums/failure-category only, capped by EVALUATION_FAILURE_SAMPLE_LIMIT.
    failures: { type: 'jsonb', notNull: true, default: '[]' },
    examples_evaluated: { type: 'integer', notNull: true, default: 0 },
    examples_skipped: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.addConstraint(REPORTS, `${REPORTS}_mode_chk`, {
    check: "mode IN ('live', 'test_stub')",
  });
  pgm.addConstraint(REPORTS, `${REPORTS}_status_chk`, {
    check: "status IN ('complete', 'partial', 'skipped')",
  });
  pgm.addConstraint(REPORTS, `${REPORTS}_skip_reason_chk`, {
    check: "skip_reason IN ('cost_capped', 'killed', 'no_examples', 'none')",
  });
  // Cross-field completeness invariant: a complete run skipped nothing; a partial run only trips
  // on cost/kill mid-run; a skipped run trips on cost/kill before any example, or has none.
  pgm.addConstraint(REPORTS, `${REPORTS}_status_skip_chk`, {
    check:
      "(status = 'complete' AND skip_reason = 'none') OR " +
      "(status = 'partial' AND skip_reason IN ('cost_capped', 'killed')) OR " +
      "(status = 'skipped' AND skip_reason IN ('cost_capped', 'killed', 'no_examples'))",
  });
  pgm.createIndex(REPORTS, 'created_at', { name: `${REPORTS}_created_at_idx` });

  // Append-only grants: SELECT + INSERT only, never UPDATE/DELETE (migration 5 / 15 pattern).
  // restricted_role / purge_role are granted NOTHING — these are not restricted, not purged.
  pgm.sql(`GRANT SELECT, INSERT ON ${EXAMPLES}, ${REJECTIONS}, ${REPORTS} TO app_role;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`REVOKE SELECT, INSERT ON ${EXAMPLES}, ${REJECTIONS}, ${REPORTS} FROM app_role;`);
  pgm.dropTable(REPORTS);
  pgm.dropTable(REJECTIONS);
  pgm.dropTable(EXAMPLES);
};
