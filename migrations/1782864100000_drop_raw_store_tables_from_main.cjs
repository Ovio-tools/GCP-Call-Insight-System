'use strict';

/**
 * ADR 0008 Move 2 — raw_transcripts + token_vault move to DB-B (raw store). Drop them from DB-A.
 * DESTRUCTIVE but pre-production: no live data. up() is guarded by an empty-table check that
 * refuses to drop if either table unexpectedly holds rows. down() recreates the tables + grants as
 * they were pre-drop so the change is reversible. match_keys stays in DB-A (unchanged).
 *
 * Reversibility note: down() restores the FULL pre-drop grant state — migrations 002/003/005 PLUS
 * migration 013's column-scoped purge_role SELECT/UPDATE grants on these two tables — so it is
 * genuinely reversible. Migration 013 stays recorded as applied and src/retention/purge.ts relies
 * on those column-scoped grants, so a single-step down() that restored only the 005 state would
 * leave purge_role missing its SELECT/UPDATE. (schema-roundtrip is already red locally for an
 * unrelated key_admin_role roles-down issue; this migration does not change that.)
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');
exports.shorthands = undefined;
const now = (pgm) => pgm.func('now()');

/** @param {MB} pgm */
exports.up = (pgm) => {
  // Safety guard (CLAUDE.md §5): refuse to drop the highest-sensitivity store if it holds any
  // data. Passes cleanly pre-production (tables empty), including when Move 2 deploys to prod
  // AFTER the raw data has been migrated to DB-B.
  pgm.sql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM raw_transcripts) OR EXISTS (SELECT 1 FROM token_vault) THEN
    RAISE EXCEPTION 'refusing to drop non-empty raw_transcripts/token_vault; migrate raw data to DB-B first (ADR 0008 Move 2)';
  END IF;
END $$;`);
  // Grants are cascade-dropped by DROP TABLE, but revoke explicitly first for clarity/symmetry.
  pgm.sql('REVOKE ALL ON token_vault FROM restricted_role;');
  pgm.sql('REVOKE ALL ON raw_transcripts FROM app_role;');
  pgm.sql('REVOKE ALL ON raw_transcripts, token_vault FROM purge_role;');
  pgm.dropTable('token_vault');
  pgm.dropTable('raw_transcripts');
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.createTable('raw_transcripts', {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    ciphertext: { type: 'bytea', notNull: true },
    key_version: {
      type: 'integer',
      notNull: true,
      references: 'key_versions',
      onDelete: 'RESTRICT',
    },
    fetched_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });
  pgm.createTable(
    'token_vault',
    {
      call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
      token: { type: 'text', notNull: true },
      ciphertext: { type: 'bytea', notNull: true },
      key_version: {
        type: 'integer',
        notNull: true,
        references: 'key_versions',
        onDelete: 'RESTRICT',
      },
      created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
      ...retentionColumns(),
    },
    { constraints: { primaryKey: ['call_id', 'token'] } },
  );
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON raw_transcripts TO app_role;');
  pgm.sql('REVOKE ALL ON token_vault FROM app_role;');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON token_vault TO restricted_role;');
  pgm.sql('GRANT DELETE ON raw_transcripts, token_vault TO purge_role;');
  // Migration 013's column-scoped purge_role grants (still recorded as applied; src/retention/
  // purge.ts relies on them). Restored here so a single-step down() is a faithful pre-drop state.
  pgm.sql(
    'GRANT SELECT (call_id, retention_eligible_at, soft_deleted_at, hard_deleted_at) ON raw_transcripts TO purge_role;',
  );
  pgm.sql(
    'GRANT UPDATE (soft_deleted_at, hard_deleted_at, ciphertext) ON raw_transcripts TO purge_role;',
  );
  pgm.sql(
    'GRANT SELECT (call_id, token, retention_eligible_at, soft_deleted_at, hard_deleted_at) ON token_vault TO purge_role;',
  );
  pgm.sql(
    'GRANT UPDATE (soft_deleted_at, hard_deleted_at, ciphertext) ON token_vault TO purge_role;',
  );
};
