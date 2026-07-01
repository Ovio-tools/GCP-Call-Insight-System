import { MIGRATION_FAILED, FatalBootError, sanitizeConnectionContext } from './codes.js';

export type MigrationDirection = 'up' | 'down';

/** Option bag passed to node-pg-migrate's runner. Loosely typed so the unit test
 * can inject a stub without depending on the library's full RunnerOption type. */
export type MigrationRunner = (options: Record<string, unknown>) => Promise<unknown>;

export interface RunMigrationsDeps {
  runner?: MigrationRunner;
  databaseUrl?: string;
  migrationsDir?: string;
}

/** Directory holding migration files (relative to the process cwd = repo root). */
const DEFAULT_MIGRATIONS_DIR = 'migrations';

/**
 * Run migrations in one direction. `up` applies all pending; `down` rolls back one.
 * Any failure (including a missing DATABASE_URL) becomes a MIGRATION_FAILED
 * FatalBootError.
 *
 * Lock note: the installed node-pg-migrate (8.0.4) takes its advisory lock via
 * `pg_try_advisory_lock`, which fails fast rather than waiting — there is no
 * `advisoryLockMode: 'wait'` option in this version (only `noLock` and
 * `lockValue`). We leave locking on its default (enabled) so concurrent
 * pre-deploy runs still fail loudly instead of racing, but a concurrent run will
 * surface as a MIGRATION_FAILED error rather than serialize. See task report for
 * detail; revisit if node-pg-migrate later adds a waiting lock mode.
 */
export async function runMigrations(
  direction: MigrationDirection,
  deps: RunMigrationsDeps = {},
): Promise<void> {
  const databaseUrl = deps.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new FatalBootError(MIGRATION_FAILED, `${MIGRATION_FAILED}: DATABASE_URL is not set`, {
      missing: 'DATABASE_URL',
    });
  }
  const runner = deps.runner ?? (await loadDefaultRunner());
  const dir = deps.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  try {
    await runner({
      databaseUrl,
      dir,
      direction,
      count: direction === 'up' ? Infinity : 1,
      migrationsTable: 'pgmigrations',
    });
  } catch (cause) {
    throw new FatalBootError(
      MIGRATION_FAILED,
      `${MIGRATION_FAILED}: ${(cause as Error).message}`,
      sanitizeConnectionContext(databaseUrl),
    );
  }
}

/** Adapter to node-pg-migrate's named `runner` export. Loaded lazily so the unit
 * test (which injects a stub) never imports the library. */
async function loadDefaultRunner(): Promise<MigrationRunner> {
  const mod = await import('node-pg-migrate');
  return mod.runner as unknown as MigrationRunner;
}
