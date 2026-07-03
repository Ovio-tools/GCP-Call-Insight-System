'use strict';

/**
 * Migration 10 — component_heartbeats (Task 7.3, status surface).
 *
 * An in-DB MIRROR of the outbound Task 7.1 dead-man's-switch pings, so the authenticated
 * status surface can render each long-running component's last-successful-run and health
 * WITHOUT reaching out to the external monitor. The external per-component checks
 * (`WORKER_CHECK_URL` / `RECONCILIATION_CHECK_URL` / `RETENTION_CHECK_URL`) stay the
 * authoritative alerting source — this table is a best-effort read model only, never the
 * alarm. A write failure is sanitized-logged and never blocks a ping or fails a run.
 *
 * One row per component (PK = component). `detail` carries COUNTS ONLY, never customer data
 * or PII — writers validate it through the content-field guard before insert. Additive and
 * low-sensitivity; down() drops the table.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

/** DEFAULT now() for a timestamptz column. */
const now = (pgm) => pgm.func('now()');

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('component_heartbeats', {
    // The component identity (COMPONENT enum in src/failure-model/categories.ts, kebab-case:
    // 'worker', 'reconciliation-cron', 'retention-cron', 'webhook-receiver', ...). Text, not a
    // pg enum — the value set is owned by the code layer, like call_state.status.
    component: { type: 'text', primaryKey: true },
    // When this component last had a fully-successful periodic run/liveness tick.
    last_run_at: { type: 'timestamptz', notNull: true },
    // Coarse health the writer reported for that tick ('ok' | 'degraded'). Text: the
    // vocabulary is small and owned by the status layer.
    last_status: { type: 'text', notNull: true, default: 'ok' },
    // Counts-only, PII-free extra detail (content-field-guarded before insert).
    detail: { type: 'jsonb', notNull: true, default: '{}' },
    updated_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });
  pgm.sql(
    'COMMENT ON COLUMN component_heartbeats.detail IS ' +
      "'Counts-only, PII-free liveness detail. Never customer data or transcript content " +
      "(content-field-guarded before insert).';",
  );

  // Explicit grant (migration 5 uses per-table grants, not default privileges — future
  // tables must be granted deliberately). app_role writes heartbeats (worker/crons) and
  // reads them (status surface): DML only, no DELETE, no DDL. No restricted-role access.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON component_heartbeats TO app_role;');
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  // dropTable removes the table and its grants together; the explicit revoke keeps the
  // down migration symmetric and readable.
  pgm.sql('REVOKE SELECT, INSERT, UPDATE ON component_heartbeats FROM app_role;');
  pgm.dropTable('component_heartbeats');
};
