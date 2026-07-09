import pg from 'pg';

const { Pool } = pg;

/** Set only when a real Postgres is available. Absent locally → DB tests skip. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

/** Raw-store (DB-B) test database. Absent locally → raw-store DB tests skip. */
export const TEST_RAW_DATABASE_URL = process.env.TEST_RAW_DATABASE_URL;
export const hasRawTestDb = Boolean(TEST_RAW_DATABASE_URL);

/** node-pg-migrate's runner, loosely typed (mirrors src/boot/migrate-runner.ts). */
type LooseRunner = (options: Record<string, unknown>) => Promise<unknown>;

/**
 * Apply or roll back migrations against TEST_DATABASE_URL. `down` defaults to rolling
 * back EVERYTHING (count Infinity), unlike the CLI which rolls back one — the
 * round-trip test needs a full unwind. Uses the same ignorePattern as the runner.
 */
export async function migrate(
  direction: 'up' | 'down',
  count: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const mod = await import('node-pg-migrate');
  const run = mod.runner as unknown as LooseRunner;
  await run({
    databaseUrl: TEST_DATABASE_URL,
    dir: 'migrations',
    direction,
    count,
    migrationsTable: 'pgmigrations',
    ignorePattern: '(\\..*|.*\\.md)',
  });
}

/**
 * Apply or roll back migrations against TEST_RAW_DATABASE_URL (DB-B, the isolated
 * raw-transcript store). Mirrors `migrate` but targets the `migrations-raw` dir.
 */
export async function migrateRaw(
  direction: 'up' | 'down',
  count: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  if (!TEST_RAW_DATABASE_URL) throw new Error('TEST_RAW_DATABASE_URL is not set');
  const mod = await import('node-pg-migrate');
  const run = mod.runner as unknown as LooseRunner;
  await run({
    databaseUrl: TEST_RAW_DATABASE_URL,
    dir: 'migrations-raw',
    direction,
    count,
    migrationsTable: 'pgmigrations',
    ignorePattern: '(\\..*|.*\\.md)',
  });
}

/** A pool bound to the test database. Callers end() it in afterAll. */
export function makePool(): pg.Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL });
}

/** Owner pool bound to the raw-store (DB-B) test database. Callers end() it. */
export function makeRawPool(): pg.Pool {
  return new Pool({ connectionString: TEST_RAW_DATABASE_URL });
}
