'use strict';

/**
 * Migration 2/5 — core (non-restricted, non-encrypted) tables.
 *
 * The 15 tables that any working role may touch. The three restricted/encrypted
 * tables (token_vault, match_keys, raw_transcripts) are migration 3. Retention
 * bookkeeping is spread from migrations/lib/columns.cjs onto the purgeable tables
 * only (here: raw_webhook_events, clean_transcripts, redaction_findings).
 *
 * Tables are created parents-first so column-level FKs resolve; down() drops them in
 * reverse order.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');

exports.shorthands = undefined;

/** DEFAULT now() for a timestamptz column. */
const now = (pgm) => pgm.func('now()');
/** DEFAULT gen_random_uuid() for a uuid primary key. */
const uuid = (pgm) => pgm.func('gen_random_uuid()');

/** Shared snapshot-column comment (CLAUDE.md §4). */
const SNAPSHOT_COMMENT =
  'Sanitized failure-model snapshot (CLAUDE.md §4): error_code, root_cause_category, ' +
  'severity, impact, processing_state, remediation_now, remediation_fix, data_safe, ' +
  'calls_state, owner, runbook_ref, context. Never PII or transcript content.';

/** Tables created here, in creation order (down drops the reverse). */
const TABLES = [
  'call_state',
  'key_versions',
  'raw_webhook_events',
  'clean_transcripts',
  'redaction_findings',
  'structured_knowledge',
  'review_queue',
  'operator_actions',
  'model_invocations',
  'daily_cost_usage',
  'alert_events',
  'backfill_runs',
  'consent_gates',
  'processing_log',
  'dead_letter',
];

/** @param {MB} pgm */
exports.up = (pgm) => {
  // --- call_state: the per-call spine. Durable, never purged (no retention cols). ---
  pgm.createTable('call_state', {
    call_id: { type: 'text', primaryKey: true },
    source: { type: 'text', notNull: true },
    source_metadata: { type: 'jsonb', notNull: true, default: '{}' },
    // current_stage/status are the pipeline state machine (Task 2.x owns the value
    // sets), so they stay text here rather than inventing an enum now.
    current_stage: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    updated_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.createIndex('call_state', ['status', 'current_stage'], {
    name: 'call_state_status_stage_idx',
  });

  // --- key_versions: DEK metadata + external reference ONLY. No key bytes. ---
  pgm.createTable('key_versions', {
    key_version: { type: 'integer', primaryKey: true },
    status: { type: 'key_version_status', notNull: true },
    wrapped_dek_ref: { type: 'text', notNull: true },
    kek_version: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    destroyed_at: { type: 'timestamptz' },
  });
  pgm.sql(
    'COMMENT ON COLUMN key_versions.wrapped_dek_ref IS ' +
      "'External secret-store pointer/identifier for the wrapped DEK. NEVER the wrapped " +
      "key bytes — no recoverable key material lives in Postgres (crypto-shredding).';",
  );

  // --- raw_webhook_events: allowlisted metadata only. Purgeable. ---
  pgm.createTable('raw_webhook_events', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    received_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    source: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    signature_status: { type: 'signature_status', notNull: true },
    ...retentionColumns(),
  });
  pgm.createIndex('raw_webhook_events', 'received_at', {
    name: 'raw_webhook_events_received_at_idx',
  });

  // --- clean_transcripts: redacted text + risk score. Purgeable. ---
  pgm.createTable('clean_transcripts', {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    redacted_text: { type: 'text', notNull: true },
    redaction_risk_score: { type: 'numeric(5,4)', notNull: true },
    redaction_reasons: { type: 'jsonb', notNull: true, default: '[]' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });

  // --- redaction_findings: detected entities; token ref or hash, never raw value. ---
  pgm.createTable('redaction_findings', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    entity_type: { type: 'text', notNull: true },
    token_ref: { type: 'text' },
    value_hash: { type: 'bytea' },
    residual_scan_result: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });
  pgm.createIndex('redaction_findings', 'call_id', { name: 'redaction_findings_call_id_idx' });

  // --- structured_knowledge: the durable extracted record (execution plan 5.2). ---
  pgm.createTable('structured_knowledge', {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    call_intent: { type: 'call_intent', notNull: true },
    // Controlled plumbing vocabulary; the CHECK/enum lands in Task 5.2 when the list
    // is defined. Text now — do NOT invent categories here.
    service_category: { type: 'text', notNull: true },
    problem_statement: { type: 'text' },
    symptoms: { type: 'jsonb', notNull: true, default: '[]' },
    customer_language: { type: 'jsonb', notNull: true, default: '[]' },
    location_in_home: { type: 'text' },
    access_or_scheduling_notes: { type: 'text' },
    prior_attempts: { type: 'text' },
    urgency: { type: 'urgency', notNull: true },
    concerns: { type: 'jsonb', notNull: true, default: '[]' },
    // Internal-only; controlled-value set finalized in Task 5.2. Text now.
    sentiment: { type: 'text', notNull: true },
    acquisition_source: { type: 'text' },
    competitor_mentions: { type: 'jsonb', notNull: true, default: '[]' },
    schema_version: { type: 'integer', notNull: true },
    prompt_version: { type: 'text', notNull: true },
    model_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.createIndex('structured_knowledge', 'call_intent', {
    name: 'structured_knowledge_intent_idx',
  });
  pgm.createIndex('structured_knowledge', 'service_category', {
    name: 'structured_knowledge_category_idx',
  });
  pgm.createIndex('structured_knowledge', 'urgency', { name: 'structured_knowledge_urgency_idx' });

  // --- review_queue: held calls awaiting a person. ---
  pgm.createTable('review_queue', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    held_reason: { type: 'held_reason', notNull: true },
    status: { type: 'review_status', notNull: true, default: 'open' },
    assignee: { type: 'text' },
    sla_due_at: { type: 'timestamptz' },
    escalated_at: { type: 'timestamptz' },
    raw_purged_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.createIndex('review_queue', 'status', {
    name: 'review_queue_open_idx',
    where: "status IN ('open', 'in_review')",
  });
  pgm.createIndex('review_queue', 'call_id', { name: 'review_queue_call_id_idx' });

  // --- operator_actions: audit trail of review-surface actions. ---
  pgm.createTable('operator_actions', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    review_queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'review_queue',
      onDelete: 'RESTRICT',
    },
    actor: { type: 'text', notNull: true },
    action: { type: 'operator_action', notNull: true },
    before: { type: 'jsonb' },
    after: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.createIndex('operator_actions', 'review_queue_id', {
    name: 'operator_actions_review_queue_id_idx',
  });

  // --- model_invocations: per model call, id + prompt version + token counts. ---
  pgm.createTable('model_invocations', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    stage: { type: 'text', notNull: true },
    model_id: { type: 'text', notNull: true },
    prompt_version: { type: 'text', notNull: true },
    input_tokens: { type: 'integer', notNull: true, default: 0 },
    output_tokens: { type: 'integer', notNull: true, default: 0 },
    outcome: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.createIndex('model_invocations', 'call_id', { name: 'model_invocations_call_id_idx' });
  pgm.createIndex('model_invocations', 'created_at', { name: 'model_invocations_created_at_idx' });

  // --- daily_cost_usage: per-day token + cost totals. ---
  pgm.createTable('daily_cost_usage', {
    day: { type: 'date', primaryKey: true },
    input_tokens: { type: 'bigint', notNull: true, default: 0 },
    output_tokens: { type: 'bigint', notNull: true, default: 0 },
    estimated_cost: { type: 'numeric(12,6)', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  // --- alert_events: emitted alerts with dedup key + sanitized snapshot. ---
  pgm.createTable('alert_events', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    error_code: { type: 'text', notNull: true },
    root_cause_category: { type: 'text', notNull: true },
    severity: { type: 'severity', notNull: true },
    dedup_key: { type: 'text', notNull: true },
    acknowledged_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    failure_snapshot: { type: 'jsonb', notNull: true, default: '{}' },
  });
  // One live (unacknowledged) alert per dedup key; a resolved incident may recur.
  pgm.createIndex('alert_events', 'dedup_key', {
    name: 'alert_events_dedup_key_unack_idx',
    unique: true,
    where: 'acknowledged_at IS NULL',
  });
  pgm.sql(`COMMENT ON COLUMN alert_events.failure_snapshot IS '${SNAPSHOT_COMMENT}';`);

  // --- backfill_runs: batch windows + checkpoints. ---
  pgm.createTable('backfill_runs', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    window_start: { type: 'timestamptz', notNull: true },
    window_end: { type: 'timestamptz', notNull: true },
    last_checkpoint: { type: 'text' },
    status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    updated_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  // --- consent_gates: recorded consents + legal gates. gate_type set is undefined
  //     in the spec, so text now (constraint added by the task that defines it). ---
  pgm.createTable('consent_gates', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    gate_type: { type: 'text', notNull: true },
    recorded_by: { type: 'text', notNull: true },
    evidence_ref: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  // --- processing_log: per-stage audit trail. call_id is unconstrained text so a log
  //     write can never fail on a missing FK. ---
  pgm.createTable('processing_log', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text' },
    stage: { type: 'text', notNull: true },
    outcome: { type: 'text', notNull: true },
    error_code: { type: 'text' },
    detail: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    failure_snapshot: { type: 'jsonb' },
  });
  pgm.createIndex('processing_log', 'call_id', { name: 'processing_log_call_id_idx' });
  pgm.sql(`COMMENT ON COLUMN processing_log.failure_snapshot IS '${SNAPSHOT_COMMENT}';`);

  // --- dead_letter: jobs that exhausted retries. call_id unconstrained (a dead job may
  //     reference a call that never got a call_state row). ---
  pgm.createTable('dead_letter', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text' },
    job_payload: { type: 'jsonb', notNull: true, default: '{}' },
    error_code: { type: 'text', notNull: true },
    root_cause_category: { type: 'text', notNull: true },
    last_error: { type: 'text' },
    failed_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    failure_snapshot: { type: 'jsonb', notNull: true, default: '{}' },
  });
  pgm.sql(`COMMENT ON COLUMN dead_letter.failure_snapshot IS '${SNAPSHOT_COMMENT}';`);
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  for (const table of [...TABLES].reverse()) {
    pgm.dropTable(table);
  }
};
