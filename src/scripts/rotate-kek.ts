import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { isKeyStoreProvider, keyStoreForCli } from '../crypto/index.js';
import { rotateKek } from '../key-lifecycle/rotate-kek.js';

/**
 * rotate-kek CLI (Task 8.2) — activate a NEW KEK: the old KEK is retired (still unwraps its
 * existing DEKs) and new DEKs are created under the new KEK. This is NOT destructive (nothing is
 * shredded), so it needs only `--actor` + `--approval-ref`/`--reason`, not the destroy kill switch.
 * Rewrapping existing DEKs under the new KEK is deferred to Task 8.2b. Usage:
 *   node dist/scripts/rotate-kek.js --new-kek-version kek-2 --actor ops@x --approval-ref JIRA-123
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'new-kek-version': { type: 'string' },
      actor: { type: 'string' },
      'approval-ref': { type: 'string' },
      reason: { type: 'string' },
    },
  });

  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'rotate-kek' });
  if (!isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    throw new Error('rotate-kek requires CRYPTO_KEY_PROVIDER=keystore or railway');
  }
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const newKekVersion = values['new-kek-version'];
  if (!newKekVersion) throw new Error('rotate-kek: --new-kek-version is required');

  const keyStore = keyStoreForCli(config);
  const pool = createAppPool(config.DATABASE_URL, 'key_admin_role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await rotateKek({
      db: client,
      keyStore,
      newKekVersion,
      actor: values.actor ?? '',
      ...(values['approval-ref'] ? { approvalRef: values['approval-ref'] } : {}),
      ...(values.reason ? { reason: values.reason } : {}),
    });
    await client.query('COMMIT');
    logger.info(
      { old_kek_version: result.oldKekVersion, new_kek_version: result.newKekVersion },
      'rotated active KEK',
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`rotate-kek failed: ${String(err)}\n`);
    process.exit(1);
  });
}
