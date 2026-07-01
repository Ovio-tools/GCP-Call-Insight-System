import pg from 'pg';

const { Pool } = pg;

/** A pg role identifier: lower_snake_case, as created by migration 4. */
const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Roles are lower-snake by our own migration convention; reject anything else so the
 * value can never smuggle extra startup options into the connection string. */
function assertRole(role: string): void {
  if (!ROLE_IDENTIFIER.test(role)) {
    throw new Error(`invalid role name: ${JSON.stringify(role)}`);
  }
}

/**
 * Application pool. Every connection starts with the `role` GUC set to `app_role` via
 * the Postgres startup `options` parameter (equivalent to `SET ROLE app_role`), so the
 * privacy boundary is DB-enforced: ordinary DAL queries run as `app_role` and a stray
 * read of `token_vault` / `match_keys` fails with SQLSTATE 42501, not merely by code
 * convention.
 *
 * Restricted operations temporarily `SET LOCAL ROLE restricted_role` inside a
 * transaction (see `restricted/restricted-context.ts`); Postgres allows that because
 * `SET ROLE` membership is checked against the session/login user — which must be a
 * NOINHERIT member of both `app_role` and `restricted_role` — not against the currently
 * active role. The role reverts to `app_role` at COMMIT/ROLLBACK.
 *
 * Setting the role at connection startup (rather than in a `connect` event handler)
 * makes it synchronous and fail-closed: if the login user isn't a member of `role`, the
 * connection itself errors instead of silently serving queries as an over-privileged
 * user.
 */
export function createAppPool(connectionString: string, role = 'app_role'): pg.Pool {
  assertRole(role);
  return new Pool({ connectionString, options: `-c role=${role}` });
}

/**
 * Owner/admin pool — connects as the raw login user with no role switch. For migration
 * running, test setup, and the retention/purge paths that legitimately need privileges
 * `app_role` lacks (e.g. DELETE). Application code paths should use {@link createAppPool}.
 */
export function createOwnerPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}
