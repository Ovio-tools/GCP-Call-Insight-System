'use strict';

/**
 * Migration 19 — grant `app_role` SELECT on `kek_versions`.
 *
 * The keystore boot readiness check (`assertKeyLifecycleReady`, wired into the worker,
 * backfill runner, and consented sample-validation job) runs
 * `SELECT count(*) FROM kek_versions WHERE status = 'active'` through the plain app pool
 * (app_role). Migration 017 created `kek_versions` but granted it ONLY to `key_admin_role`,
 * so every keystore-mode service failed to boot with `DAL_RESTRICTED_ACCESS_DENIED`
 * (SQLSTATE 42501) — a real bug that blocks the production worker, not just the demo.
 *
 * A table-level read grant is safe: `kek_versions` holds no key bytes, only
 * `external_kek_ref` (a pointer to the external secret store) and lifecycle metadata —
 * see the migration-017 column comment and CLAUDE.md §2. This mirrors how the sibling
 * metadata table `key_versions` is already granted to app_role (migration 005). No
 * INSERT/UPDATE/DELETE — app_role only reads readiness; the lifecycle CLIs
 * (`key_admin_role`) remain the sole writers.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

/** @param {MB} pgm */
exports.up = (pgm) => {
  pgm.sql('GRANT SELECT ON kek_versions TO app_role;');
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.sql('REVOKE SELECT ON kek_versions FROM app_role;');
};
