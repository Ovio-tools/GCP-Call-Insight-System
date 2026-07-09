import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { createBootLogger } from '../boot/logger.js';
import { MIGRATION_FAILED, FatalBootError, failBoot } from '../boot/codes.js';
import { runMigrations, type MigrationDirection } from '../boot/migrate-runner.js';

export interface MigrateEnv {
  RAW_DATABASE_URL?: string;
}

/**
 * Run DB-A migrations, then DB-B (raw-store) migrations when RAW_DATABASE_URL is
 * set. Extracted so the RAW gating is unit-testable without process.exit.
 *
 * The two stores migrate independently — there is no cross-DB 2PC — so a mid-run
 * failure can leave DB-A ahead of DB-B until the next (idempotent) retry re-runs
 * the pending set on both.
 *
 * Ordering note: DB-B has no cross-DB FK to DB-A, so migration order between the
 * two stores is immaterial. Running both in one command only ensures the two
 * stores migrate together per deploy — count=1 on `down`, Infinity on `up`
 * (handled inside runMigrations), symmetric in both directions.
 */
export async function runConfiguredMigrations(
  direction: MigrationDirection,
  logger: Logger,
  env: MigrateEnv = process.env,
  run: typeof runMigrations = runMigrations,
): Promise<void> {
  // DB-A: runMigrations reads process.env.DATABASE_URL internally — no override here.
  await run(direction);
  // DB-B (raw store) — ADR 0008 Move 2. Runs only when RAW_DATABASE_URL is configured.
  if (env.RAW_DATABASE_URL) {
    await run(direction, {
      databaseUrl: env.RAW_DATABASE_URL,
      migrationsDir: 'migrations-raw',
    });
    logger.info({ direction, target: 'raw-store' }, 'raw-store migrations complete');
  }
}

/**
 * Railway pre-deploy entrypoint. `node dist/scripts/migrate.js up|down`. Runs
 * migrations; on failure emits MIGRATION_FAILED and exits non-zero so Railway fails
 * the deploy. Kept thin — the testable logic lives in migrate-runner.ts and
 * runConfiguredMigrations.
 */
async function main(): Promise<void> {
  const direction: MigrationDirection = process.argv[2] === 'down' ? 'down' : 'up';
  const logger = createBootLogger({ name: 'migrate' });
  try {
    await runConfiguredMigrations(direction, logger);
    logger.info({ direction }, 'migrations complete');
  } catch (err) {
    // Every failure — including a non-FatalBootError from deep in the runner —
    // becomes a structured MIGRATION_FAILED via failBoot. No raw stack traces as
    // alerts (build plan §5); node-pg-migrate already logs its own detail.
    const fatal =
      err instanceof FatalBootError
        ? err
        : new FatalBootError(
            MIGRATION_FAILED,
            `${MIGRATION_FAILED}: ${(err as Error)?.message ?? String(err)}`,
          );
    failBoot(logger, fatal);
  }
}

// Only run when invoked directly (node dist/scripts/migrate.js …), not when
// imported by a test — importing must not trigger main()/process.exit.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Last resort only: a failure before the logger exists (e.g. logger construction
    // itself). Still tagged with the stable code, never a bare trace.
    process.stderr.write(`${MIGRATION_FAILED}: ${String(err)}\n`);
    process.exit(1);
  });
}
