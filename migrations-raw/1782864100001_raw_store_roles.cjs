'use strict';

/**
 * Migration 1/2 (DB-B raw-store set) — least-privilege group roles.
 *
 * Three NOLOGIN group roles (permission bundles, not login identities — the real
 * Railway login user is granted membership out-of-band, so no passwords live in the
 * repo):
 *   - app_role:        DML on working tables; NO DELETE, NO DDL, NO vault/match access.
 *   - restricted_role: the only role that may read token_vault / match_keys.
 *   - purge_role:      DELETE on purgeable tables (retention cron only).
 *
 * CREATE is existence-guarded so it is a no-op when a role was pre-provisioned (e.g.
 * a superuser created it on locked-down managed Postgres). Roles we DO create are
 * stamped with a marker comment; down() drops ONLY marker-stamped roles, so a
 * pre-provisioned cluster-global role is never destroyed out from under other
 * databases/services. Grants are added in migration 2 and revoked by its down() first
 * (down runs 2 -> 1), so a role owns nothing by the time it is dropped here.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

const ROLES = ['app_role', 'restricted_role', 'purge_role'];
// Intentionally DISTINCT from the DB-A marker ('...-migration'): roles are cluster-global, so if
// RAW_DATABASE_URL were ever (mis)pointed at the DB-A instance, an identical marker would let this
// down() DROP DB-A's stamped roles. The '-raw' suffix makes DB-B's down() self-safe on any topology.
const MARKER = 'created_by:gcp-call-insights-migration-raw';

/** @param {MB} pgm */
exports.up = (pgm) => {
  for (const role of ROLES) {
    pgm.sql(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} NOLOGIN;
    COMMENT ON ROLE ${role} IS '${MARKER}';
  END IF;
END
$$;`);
  }
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  for (const role of ROLES) {
    pgm.sql(`
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles r
    JOIN pg_shdescription d
      ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass
    WHERE r.rolname = '${role}'
      AND d.description = '${MARKER}'
  ) THEN
    DROP ROLE ${role};
  END IF;
END
$$;`);
  }
};
