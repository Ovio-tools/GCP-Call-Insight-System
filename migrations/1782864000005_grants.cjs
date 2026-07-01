'use strict';

/**
 * Migration 5/5 — privilege grants for the three group roles.
 *
 * Explicit per-table grants (not ALTER DEFAULT PRIVILEGES) so the privilege surface is
 * auditable and future tables don't silently inherit access. Enforcement of the
 * restricted boundary is the REVOKE ALL on token_vault/match_keys from app_role.
 *
 * down() revokes exactly what up() granted, returning the roles (created empty in
 * migration 4) to a no-privilege state. down runs before migration 4's role drop.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { PURGEABLE_TABLES } = require('./lib/columns.cjs');

exports.shorthands = undefined;

/** Working tables app_role may read/write. Everything except the restricted vault /
 * match-key tables. raw_transcripts is encrypted but not restricted-role-only. */
const APP_TABLES = [
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
  'raw_transcripts',
];

/** Restricted tables only restricted_role may touch. */
const RESTRICTED_TABLES = ['token_vault', 'match_keys'];

const appList = APP_TABLES.join(', ');
const restrictedList = RESTRICTED_TABLES.join(', ');
const purgeList = PURGEABLE_TABLES.join(', ');

/** @param {MB} pgm */
exports.up = (pgm) => {
  // Schema usage (explicit even though PUBLIC has USAGE by default).
  pgm.sql('GRANT USAGE ON SCHEMA public TO app_role, restricted_role, purge_role;');

  // app_role: DML on working tables, NO DELETE, NO DDL.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${appList} TO app_role;`);
  // Enforce the restricted boundary: app_role can never see the vault or match keys.
  pgm.sql(`REVOKE ALL ON ${restrictedList} FROM app_role;`);

  // restricted_role: the only reader/writer of the vault + match keys, plus the
  // key_versions metadata it needs to resolve key_version.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${restrictedList} TO restricted_role;`);
  pgm.sql('GRANT SELECT ON key_versions TO restricted_role;');

  // purge_role: hard-delete on purgeable tables (retention cron only).
  pgm.sql(`GRANT DELETE ON ${purgeList} TO purge_role;`);
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.sql(`REVOKE DELETE ON ${purgeList} FROM purge_role;`);
  pgm.sql('REVOKE SELECT ON key_versions FROM restricted_role;');
  pgm.sql(`REVOKE SELECT, INSERT, UPDATE ON ${restrictedList} FROM restricted_role;`);
  pgm.sql(`REVOKE SELECT, INSERT, UPDATE ON ${appList} FROM app_role;`);
  pgm.sql('REVOKE USAGE ON SCHEMA public FROM app_role, restricted_role, purge_role;');
};
