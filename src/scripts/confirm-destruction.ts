import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createOwnerPool } from '../db/index.js';
import { isKeyStoreProvider, keyStoreForCli } from '../crypto/index.js';
import { finalizeDestruction } from '../key-lifecycle/finalize-destruction.js';

/**
 * confirm-destruction CLI (Task 8.2) — the Phase-B finalizer, run AFTER the recovery window. It
 * reacquires the shared advisory lock, confirms every requested destruction is unrecoverable in the
 * store (`store.recoverability`), and flips those versions/KEKs to `destroyed`. Resumable and safe to
 * re-run: a version still inside its window is left pending. Usage:
 *   node dist/scripts/confirm-destruction.js --actor ops@x
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({ options: { actor: { type: 'string' } } });

  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'confirm-destruction' });
  if (!isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    throw new Error('confirm-destruction requires CRYPTO_KEY_PROVIDER=keystore or railway');
  }
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createOwnerPool(config.DATABASE_URL);
  const keyStore = keyStoreForCli(config);
  try {
    const result = await finalizeDestruction({
      pool,
      keyStore,
      actor: values.actor ?? 'confirm-destruction',
      logger,
    });
    logger.info(
      {
        finalized_deks: result.finalizedDeks,
        finalized_keks: result.finalizedKeks,
        pending_deks: result.pendingDeks,
        pending_keks: result.pendingKeks,
      },
      'destruction finalization pass complete',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`confirm-destruction failed: ${String(err)}\n`);
    process.exit(1);
  });
}
