'use strict';

/**
 * Migration 16 — Task 8.2 key lifecycle: recovery-window bookkeeping, single-active
 * enforcement, the durable KEK-metadata table, the append-only lifecycle audit log, and a
 * column-scoped key-admin role.
 *
 * Why each piece exists:
 *   1. key_versions recovery-window columns — crypto-shred is honest only if destruction is
 *      two-phase and durably modeled: `destroy_requested_at` starts the mandatory recovery
 *      window (`destroy_recovery_window_until`); `destroy_approval_ref` records the human
 *      sign-off. `destroyed_at` (migration 2) flips ONLY once the external store reports the
 *      material unrecoverable — never on the DB flag alone.
 *   2. Preflight + single-active partial unique index on key_versions — exactly one row may be
 *      `status='active'`. A loud preflight refuses to migrate a DB with multiple active rows, or
 *      with zero active rows WHILE encrypted raw/vault rows exist (that DB needs a bootstrapped
 *      key first). Zero-active on a clean DB is allowed — `bootstrap-key` seeds the first key.
 *   3. kek_versions — durable authoritative KEK state (the launch gate reads this rather than
 *      deriving destroyed-KEK state from events). `external_kek_ref` (NOT `wrapped_ref`) because a
 *      KEK is the root wrapping key, not itself wrapped. A partial unique index enforces one active
 *      KEK.
 *   4. key_lifecycle_events — append-only audit of every bootstrap / rotation / destruction, with
 *      SANITIZED metadata only (actor, approval_ref, blast-radius counts) — never PII or key bytes.
 *      No `confirmation_phrase` column: only `confirmation_matched` is persisted.
 *   5. key_admin_role — the least-privilege identity the lifecycle CLIs run as. Column-scoped
 *      metadata + audit access ONLY; it is deliberately granted NO access to raw_transcripts /
 *      token_vault — rotation reaches ciphertext through the existing app pool + RestrictedRunner.
 *
 * Reversibility: down() drops every object it created and revokes every grant, then drops
 * key_admin_role ONLY if it carries the migration marker comment (mirrors migration 4), so a
 * pre-provisioned cluster-global role is never destroyed out from under other databases.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

const MARKER = 'created_by:gcp-call-insights-migration';
const KEK_STATUS_CHK = 'kek_versions_status_chk';
const EVENT_CHK = 'key_lifecycle_events_event_chk';
const KV_ACTIVE_IDX = 'key_versions_one_active_idx';
const KEK_ACTIVE_IDX = 'kek_versions_one_active_idx';

/** The append-only lifecycle event vocabulary. Failure events are sanitized. */
const LIFECYCLE_EVENTS = [
  'key_bootstrapped',
  'kek_rotated',
  'rotate_started',
  'rotate_completed',
  'destroy_requested',
  'destroy_confirmed',
  'revoke_dek',
  'revoke_kek',
  'rotate_failed',
  'revoke_failed',
  'destroy_finalize_failed',
];

/** key_admin_role column-scoped grants — metadata + audit only, never ciphertext. */
const KV_SELECT_COLS =
  'key_version, status, wrapped_dek_ref, kek_version, created_at, destroyed_at, ' +
  'destroy_requested_at, destroy_recovery_window_until, destroy_approval_ref';
const KV_INSERT_COLS = 'key_version, status, wrapped_dek_ref, kek_version, created_at';
const KV_UPDATE_COLS =
  'status, destroy_requested_at, destroy_recovery_window_until, destroy_approval_ref, destroyed_at';
const KEK_SELECT_COLS =
  'kek_version, status, external_kek_ref, created_at, destroyed_at, ' +
  'destroy_requested_at, destroy_recovery_window_until, destroy_approval_ref';
const KEK_INSERT_COLS = 'kek_version, status, external_kek_ref, created_at';
const KEK_UPDATE_COLS =
  'status, destroy_requested_at, destroy_recovery_window_until, destroy_approval_ref, destroyed_at';

/** @param {MB} pgm */
exports.up = (pgm) => {
  // --- 1. key_versions recovery-window columns. ---
  pgm.addColumns('key_versions', {
    destroy_requested_at: { type: 'timestamptz' },
    destroy_recovery_window_until: { type: 'timestamptz' },
    destroy_approval_ref: { type: 'text' },
  });

  // --- 2. Loud preflight, then the single-active partial unique index. ---
  pgm.sql(`
DO $$
DECLARE
  active_count int;
  encrypted_count int;
BEGIN
  SELECT count(*) INTO active_count FROM key_versions WHERE status = 'active';
  IF active_count > 1 THEN
    RAISE EXCEPTION
      'migration 016 preflight: % active key_versions rows found; exactly one active key is allowed. Resolve the duplicate-active state before migrating.',
      active_count;
  END IF;
  IF active_count = 0 THEN
    SELECT (SELECT count(*) FROM raw_transcripts) + (SELECT count(*) FROM token_vault)
      INTO encrypted_count;
    IF encrypted_count > 0 THEN
      RAISE EXCEPTION
        'migration 016 preflight: zero active key_versions but % encrypted raw/vault rows exist; bootstrap an active key before migrating.',
        encrypted_count;
    END IF;
  END IF;
END
$$;`);
  pgm.sql(
    `CREATE UNIQUE INDEX ${KV_ACTIVE_IDX} ON key_versions (status) WHERE status = 'active';`,
  );

  // --- 3. kek_versions: durable authoritative KEK state. ---
  pgm.createTable('kek_versions', {
    kek_version: { type: 'text', primaryKey: true },
    status: { type: 'text', notNull: true },
    // A pointer to the KEK in the external secret store; NEVER the key bytes.
    external_kek_ref: { type: 'text', notNull: true },
    destroy_requested_at: { type: 'timestamptz' },
    destroy_recovery_window_until: { type: 'timestamptz' },
    destroy_approval_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    destroyed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('kek_versions', KEK_STATUS_CHK, {
    check: "status IN ('active', 'retired', 'destroyed')",
  });
  pgm.sql(
    `CREATE UNIQUE INDEX ${KEK_ACTIVE_IDX} ON kek_versions (status) WHERE status = 'active';`,
  );
  pgm.sql(
    "COMMENT ON COLUMN kek_versions.external_kek_ref IS " +
      "'External secret-store pointer/identifier for the KEK. NEVER the key bytes — no " +
      "recoverable key material lives in Postgres (crypto-shredding).';",
  );

  // --- 4. key_lifecycle_events: append-only, sanitized audit log. ---
  const eventList = LIFECYCLE_EVENTS.map((e) => `'${e}'`).join(', ');
  pgm.createTable('key_lifecycle_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event: { type: 'text', notNull: true },
    key_version: { type: 'integer' },
    kek_version: { type: 'text' },
    actor: { type: 'text', notNull: true },
    approval_ref: { type: 'text' },
    confirmation_matched: { type: 'boolean' },
    affected_raw_count: { type: 'integer' },
    affected_vault_count: { type: 'integer' },
    rows_reencrypted: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('key_lifecycle_events', EVENT_CHK, {
    check: `event IN (${eventList})`,
  });
  pgm.createIndex('key_lifecycle_events', 'created_at', {
    name: 'key_lifecycle_events_created_at_idx',
  });

  // --- 5. key_admin_role: metadata + audit only, existence-guarded like migration 4. ---
  pgm.sql(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'key_admin_role') THEN
    CREATE ROLE key_admin_role NOLOGIN;
    COMMENT ON ROLE key_admin_role IS '${MARKER}';
  END IF;
END
$$;`);
  pgm.sql('GRANT USAGE ON SCHEMA public TO key_admin_role;');
  pgm.sql(`GRANT SELECT (${KV_SELECT_COLS}) ON key_versions TO key_admin_role;`);
  pgm.sql(`GRANT INSERT (${KV_INSERT_COLS}) ON key_versions TO key_admin_role;`);
  pgm.sql(`GRANT UPDATE (${KV_UPDATE_COLS}) ON key_versions TO key_admin_role;`);
  pgm.sql(`GRANT SELECT (${KEK_SELECT_COLS}) ON kek_versions TO key_admin_role;`);
  pgm.sql(`GRANT INSERT (${KEK_INSERT_COLS}) ON kek_versions TO key_admin_role;`);
  pgm.sql(`GRANT UPDATE (${KEK_UPDATE_COLS}) ON kek_versions TO key_admin_role;`);
  pgm.sql('GRANT SELECT, INSERT ON key_lifecycle_events TO key_admin_role;');
  // Deliberately NO grants on raw_transcripts / token_vault — rotation uses the existing
  // app pool + RestrictedRunner, never key_admin_role, to touch ciphertext.
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  // Revoke key_versions grants (the table persists, so column grants must be revoked
  // explicitly before the role can be dropped). Dropped-table grants vanish with the tables.
  pgm.sql(`REVOKE SELECT (${KV_SELECT_COLS}) ON key_versions FROM key_admin_role;`);
  pgm.sql(`REVOKE INSERT (${KV_INSERT_COLS}) ON key_versions FROM key_admin_role;`);
  pgm.sql(`REVOKE UPDATE (${KV_UPDATE_COLS}) ON key_versions FROM key_admin_role;`);
  pgm.sql('REVOKE USAGE ON SCHEMA public FROM key_admin_role;');

  pgm.dropTable('key_lifecycle_events');
  pgm.dropTable('kek_versions');

  pgm.sql(`DROP INDEX IF EXISTS ${KV_ACTIVE_IDX};`);
  pgm.dropColumns('key_versions', [
    'destroy_requested_at',
    'destroy_recovery_window_until',
    'destroy_approval_ref',
  ]);

  // Drop key_admin_role ONLY if this migration created it (marker comment present).
  pgm.sql(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles r
    JOIN pg_shdescription d
      ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass
    WHERE r.rolname = 'key_admin_role'
      AND d.description = '${MARKER}'
  ) THEN
    DROP ROLE key_admin_role;
  END IF;
END
$$;`);
};
