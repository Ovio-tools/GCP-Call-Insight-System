'use strict';

/**
 * Migration 15 — reprocess_requests durable outbox (Task 6.2).
 *
 * A `reprocess` / `approve` / `correct_extraction` review action re-enters the pipeline. The
 * enqueue is best-effort AFTER commit, so a crash or Redis outage between the state-change
 * commit and the enqueue would strand the call. This table is the durable outbox: the row is
 * written in the SAME transaction as the `call_state` transition + audit row, and the
 * reconciliation cron drains any still-`pending` rows (FOR UPDATE SKIP LOCKED + a `call_state`
 * re-check → `sent`/`superseded`). The requeue-parked scripts do NOT rescue a generic stranded
 * `processing` row — they only match kill-switch markers — so this outbox is the recovery path.
 *
 * Invariants:
 *  - UNIQUE(operator_action_id): exactly one outbox row per audited action, so a duplicate POST
 *    (which writes no second action row — audit-trail idempotency) writes no second outbox row.
 *  - status CHECK ('pending','sent','superseded'): `superseded` is the drain's verdict when the
 *    call_state no longer matches (a later operator/manual recovery moved it).
 *  - All FKs ON DELETE NO ACTION (RESTRICT) — this is an audit/recovery record; nothing in the
 *    per-call path deletes its parents.
 *  - Partial index on status='pending' — the drain's working set.
 *  - Grants mirror migration 5's per-table pattern: app_role gets SELECT/INSERT/UPDATE, never
 *    DELETE (app_role never deletes; the retention cron's purge_role is the only deleter and has
 *    no business here).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const TABLE = 'reprocess_requests';
const STATUS_CHK = 'reprocess_requests_status_chk';
const PENDING_IDX = 'reprocess_requests_pending_idx';

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // One outbox row per audited action (UNIQUE). ON DELETE NO ACTION: audit durability.
    operator_action_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'operator_actions',
      onDelete: 'NO ACTION',
    },
    call_id: {
      type: 'text',
      notNull: true,
      references: 'call_state',
      onDelete: 'NO ACTION',
    },
    review_queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'review_queue',
      onDelete: 'NO ACTION',
    },
    target_stage: { type: 'text', notNull: true },
    requested_by: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    // Prior call_state, captured for operator rollback / drain re-check diagnostics.
    prior_stage: { type: 'text' },
    prior_status: { type: 'text' },
    prior_drop_reason: { type: 'text' },
    // Retry/lock metadata for the reconciliation drain. last_error_code is a SANITIZED code
    // (a failure-model ErrorCode), never a raw message or PII.
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_error_code: { type: 'text' },
    last_attempted_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
  });

  pgm.addConstraint(TABLE, STATUS_CHK, {
    check: "status IN ('pending', 'sent', 'superseded')",
  });

  // The drain's working set: only pending rows.
  pgm.createIndex(TABLE, 'created_at', {
    name: PENDING_IDX,
    where: "status = 'pending'",
  });
  pgm.createIndex(TABLE, 'review_queue_id', { name: 'reprocess_requests_review_queue_id_idx' });

  // Per-table grants (migration 5 pattern). app_role never deletes.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${TABLE} TO app_role;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`REVOKE SELECT, INSERT, UPDATE ON ${TABLE} FROM app_role;`);
  pgm.dropTable(TABLE);
};
