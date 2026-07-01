import { createBootLogger } from '../boot/logger.js';
import { MIGRATION_FAILED, FatalBootError, failBoot } from '../boot/codes.js';
import { runMigrations, type MigrationDirection } from '../boot/migrate-runner.js';

/**
 * Railway pre-deploy entrypoint. `node dist/scripts/migrate.js up|down`. Runs
 * migrations; on failure emits MIGRATION_FAILED and exits non-zero so Railway fails
 * the deploy. Kept thin — the testable logic lives in migrate-runner.ts.
 */
async function main(): Promise<void> {
  const direction: MigrationDirection = process.argv[2] === 'down' ? 'down' : 'up';
  const logger = createBootLogger({ name: 'migrate' });
  try {
    await runMigrations(direction);
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

main().catch((err: unknown) => {
  // Last resort only: a failure before the logger exists (e.g. logger construction
  // itself). Still tagged with the stable code, never a bare trace.
  process.stderr.write(`${MIGRATION_FAILED}: ${String(err)}\n`);
  process.exit(1);
});
