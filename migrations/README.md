# migrations

node-pg-migrate migration files live here. `npm run db:migrate` (the Railway
pre-deploy command on the worker service) applies every pending migration; every
migration has an `up` and a `down`.

## Layout (Task 1.1)

Five reversible `.cjs` (CommonJS) migrations, applied in numeric-prefix order. `down`
reverses them in the opposite order, each fully undoing its own `up`:

1. `*_extensions_and_enums.cjs` — `pgcrypto` + the native ENUM types.
2. `*_core_tables.cjs` — the 15 non-restricted tables.
3. `*_restricted_tables.cjs` — `raw_transcripts`, `token_vault`, `match_keys`.
4. `*_roles.cjs` — the `app_role` / `restricted_role` / `purge_role` group roles.
5. `*_grants.cjs` — privilege grants/revokes for those roles.

`lib/columns.cjs` holds shared column fragments (the retention timestamps). It sits in
a **subdirectory** on purpose: node-pg-migrate scans this directory non-recursively and
only loads files, so `lib/` is skipped and never run as a migration. The runner also
sets `ignorePattern` to skip dotfiles and this `README.md` (otherwise node-pg-migrate
would try to `import()` it and crash); see `src/boot/migrate-runner.ts`.

Migrations are `.cjs`, not TypeScript: node-pg-migrate loads them from this raw
repo-root directory at runtime (not from `dist/`), and there is no TS loader on the
pre-deploy path.

## Roles on managed Postgres (Railway)

Migration 4 creates the three group roles with an existence guard, so a
**pre-provisioned** role is a no-op. If the migration DB user lacks `CREATEROLE` and
the roles do not yet exist, the deploy fails with `MIGRATION_FAILED`; the fallback is a
one-time manual `CREATE ROLE app_role NOLOGIN;` (and `restricted_role`, `purge_role`)
by a superuser, after which migrations run clean. `down` drops **only** roles this
migration created (detected via a marker comment), so it never removes a
pre-provisioned cluster-global role.

## Tests

The DB-integration tests in `test/db/` run only when `TEST_DATABASE_URL` is set, and
that connection must be a **superuser or `CREATEROLE`** owner (the role-isolation test
uses `SET ROLE`, which requires membership or superuser). CI provides a Postgres
service and sets `TEST_DATABASE_URL`, so the DB suite is required on every PR; local
runs without the variable skip those tests.
