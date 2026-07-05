import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { keyStoreFromConfig } from '../crypto/index.js';
import { bootstrapKey } from '../key-lifecycle/bootstrap.js';

/**
 * bootstrap-key CLI (Task 8.2) — one-time seed of the FIRST active KEK + DEK, run BEFORE any
 * service encrypts in `keystore` mode. Requires `--actor` and either `--approval-ref` or
 * `--reason` (recorded in the `key_bootstrapped` event). Runs as `key_admin_role` (metadata +
 * audit only) inside a transaction, so the KEK, DEK, and event commit atomically. Refuses to run
 * twice. Usage:
 *   node dist/scripts/bootstrap-key.js --actor ops@x --approval-ref JIRA-123 [--kek-version kek-1]
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      actor: { type: 'string' },
      'approval-ref': { type: 'string' },
      reason: { type: 'string' },
      'kek-version': { type: 'string' },
    },
  });

  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'bootstrap-key' });
  if (config.CRYPTO_KEY_PROVIDER !== 'keystore') {
    throw new Error('bootstrap-key requires CRYPTO_KEY_PROVIDER=keystore');
  }
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const kekVersion = values['kek-version'] ?? config.CRYPTO_KEK_VERSION;
  if (!kekVersion) {
    throw new Error('bootstrap-key: pass --kek-version or set CRYPTO_KEK_VERSION');
  }
  const actor = values.actor ?? '';
  const keyStore = keyStoreFromConfig(config);
  // key_admin_role: metadata + audit grants only; it can never read/write raw/vault ciphertext.
  const pool = createAppPool(config.DATABASE_URL, 'key_admin_role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await bootstrapKey({
      db: client,
      keyStore,
      kekVersion,
      actor,
      ...(values['approval-ref'] ? { approvalRef: values['approval-ref'] } : {}),
      ...(values.reason ? { reason: values.reason } : {}),
    });
    await client.query('COMMIT');
    logger.info(
      { kek_version: result.kekVersion, key_version: result.keyVersion },
      'bootstrapped first active KEK + DEK',
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
    process.stderr.write(`bootstrap-key failed: ${String(err)}\n`);
    process.exit(1);
  });
}
