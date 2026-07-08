'use strict';

/**
 * DB-B (raw store) tables — ADR 0008 Move 2. Holds ONLY the highest-sensitivity stores, on a
 * Postgres whose backups are off. Cross-DB FKs to call_state / key_versions (DB-A) are dropped:
 * Postgres cannot enforce a foreign key across databases, so call_id/key_version are plain
 * columns here (application-enforced references).
 *
 * raw_purge_tombstone is the DB-B-local finality marker: the held-cap purge deletes raw/vault AND
 * inserts the tombstone in ONE DB-B transaction, and the writers check it (same DB -> atomic,
 * race-free), preserving the "a purged call is never repopulated" guarantee.
 *
 * Grants mirror the NET DB-A privilege state for these tables (migrations 005 + 013), preserving
 * least-privilege: app_role has full DML on raw_transcripts (encrypted, not restricted) but NO
 * token_vault access; restricted_role is the only token_vault reader/writer; purge_role gets
 * COLUMN-SCOPED SELECT/UPDATE (never ciphertext in SELECT; only the scrub + timestamp columns in
 * UPDATE) plus physical DELETE for the held-cap purge. The DB-A review_queue grants have no
 * analogue here (review_queue stays in DB-A); the tombstone replaces that finality seam.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');
exports.shorthands = undefined;
const now = (pgm) => pgm.func('now()');

/** @param {MB} pgm */
exports.up = (pgm) => {
  pgm.createTable('raw_transcripts', {
    call_id: { type: 'text', primaryKey: true }, // logical ref to DB-A call_state; no cross-DB FK
    ciphertext: { type: 'bytea', notNull: true },
    key_version: { type: 'integer', notNull: true }, // logical ref to DB-A key_versions; no FK
    fetched_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });

  pgm.createTable(
    'token_vault',
    {
      call_id: { type: 'text', notNull: true },
      token: { type: 'text', notNull: true },
      ciphertext: { type: 'bytea', notNull: true },
      key_version: { type: 'integer', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
      ...retentionColumns(),
    },
    { constraints: { primaryKey: ['call_id', 'token'] } },
  );

  // Finality marker: one row per call whose raw/vault were physically purged.
  pgm.createTable('raw_purge_tombstone', {
    call_id: { type: 'text', primaryKey: true },
    purged_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  // --- Grants (mirror the NET DB-A state from migrations 005 + 013 for these tables) ---
  pgm.sql('GRANT USAGE ON SCHEMA public TO app_role, restricted_role, purge_role;');

  // app_role: full DML on raw_transcripts (encrypted, not restricted); tombstone read for the writer guard.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON raw_transcripts TO app_role;');
  pgm.sql('GRANT SELECT ON raw_purge_tombstone TO app_role;');
  // Restricted boundary: app_role can NEVER touch token_vault.
  pgm.sql('REVOKE ALL ON token_vault FROM app_role;');

  // restricted_role: the only reader/writer of token_vault; tombstone read for the writer guard.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON token_vault TO restricted_role;');
  pgm.sql('GRANT SELECT ON raw_purge_tombstone TO restricted_role;');

  // Lockstep: because purge_role SELECT is column-scoped, any raw-pool purge query (later tasks'
  // listRawPurgeEligible / held-cap) must project ONLY {call_id, token, retention_eligible_at,
  // soft_deleted_at, hard_deleted_at} — referencing e.g. fetched_at/created_at under purge_role
  // fails at runtime (permission denied), not at migrate time.
  // purge_role: COLUMN-SCOPED SELECT (identifier + retention triplet only, NEVER ciphertext) and
  // COLUMN-SCOPED UPDATE (soft/hard timestamps + the ciphertext scrub column), plus physical
  // DELETE for the held-cap purge; tombstone read/insert for the finality marker.
  pgm.sql(
    'GRANT SELECT (call_id, retention_eligible_at, soft_deleted_at, hard_deleted_at) ON raw_transcripts TO purge_role;',
  );
  pgm.sql('GRANT UPDATE (soft_deleted_at, hard_deleted_at, ciphertext) ON raw_transcripts TO purge_role;');
  pgm.sql('GRANT DELETE ON raw_transcripts TO purge_role;');
  pgm.sql(
    'GRANT SELECT (call_id, token, retention_eligible_at, soft_deleted_at, hard_deleted_at) ON token_vault TO purge_role;',
  );
  pgm.sql('GRANT UPDATE (soft_deleted_at, hard_deleted_at, ciphertext) ON token_vault TO purge_role;');
  pgm.sql('GRANT DELETE ON token_vault TO purge_role;');
  pgm.sql('GRANT SELECT, INSERT ON raw_purge_tombstone TO purge_role;');
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.sql(
    'REVOKE ALL ON raw_transcripts, token_vault, raw_purge_tombstone FROM app_role, restricted_role, purge_role;',
  );
  pgm.dropTable('raw_purge_tombstone');
  pgm.dropTable('token_vault');
  pgm.dropTable('raw_transcripts');
  pgm.sql('REVOKE USAGE ON SCHEMA public FROM app_role, restricted_role, purge_role;');
};
