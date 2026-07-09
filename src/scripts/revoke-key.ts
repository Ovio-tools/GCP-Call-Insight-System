import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createOwnerPool, createRawOwnerPool } from '../db/index.js';
import { isKeyStoreProvider, keyStoreForCli } from '../crypto/index.js';
import { createRestrictedRunner } from '../db/restricted/restricted-context.js';
import { revokeDek, revokeKek, type RevokeDeps } from '../key-lifecycle/revoke.js';

/**
 * revoke-key CLI (Task 8.2). Emergency crypto-shred of a DEK version or a KEK (and every DEK under
 * it). DESTRUCTIVE — gated by `CRYPTO_KEY_DESTROY_COMMANDS_ENABLED` AND runtime approval: `--actor`,
 * `--approval-ref`, and a `--confirm` phrase matching `REVOKE-DEK-<version>` / `REVOKE-KEK-<kek>`.
 * Only `confirmation_matched` is persisted, never the phrase. Usage:
 *   node dist/scripts/revoke-key.js --dek 3   --actor ops --approval-ref JIRA-9 --confirm REVOKE-DEK-3
 *   node dist/scripts/revoke-key.js --kek kek-2 --actor ops --approval-ref JIRA-9 --confirm REVOKE-KEK-kek-2
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dek: { type: 'string' },
      kek: { type: 'string' },
      actor: { type: 'string' },
      'approval-ref': { type: 'string' },
      reason: { type: 'string' },
      confirm: { type: 'string' },
    },
  });

  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'revoke-key' });
  if (!isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    throw new Error('revoke-key requires CRYPTO_KEY_PROVIDER=keystore or railway');
  }
  if ((values.dek && values.kek) || (!values.dek && !values.kek)) {
    throw new Error('revoke-key: pass exactly one of --dek <version> or --kek <kek-version>');
  }
  const expected = values.dek ? `REVOKE-DEK-${values.dek}` : `REVOKE-KEK-${values.kek!}`;
  if (values.confirm !== expected) {
    throw new Error(`revoke-key: pass --confirm ${expected} to authorize the revocation`);
  }
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!config.RAW_DATABASE_URL) throw new Error('RAW_DATABASE_URL is not set');

  const pool = createOwnerPool(config.DATABASE_URL);
  const rawPool = createRawOwnerPool(config.RAW_DATABASE_URL);
  const keyStore = keyStoreForCli(config);
  const deps: RevokeDeps = {
    pool,
    rawPool,
    restrictedRunner: createRestrictedRunner(rawPool),
    keyStore,
    config,
    actor: values.actor ?? '',
    confirmationMatched: true,
    logger,
    ...(values['approval-ref'] ? { approvalRef: values['approval-ref'] } : {}),
    ...(values.reason ? { reason: values.reason } : {}),
  };
  try {
    const result = values.dek
      ? await revokeDek(deps, Number(values.dek))
      : await revokeKek(deps, values.kek!);
    logger.info(
      {
        affected_raw: result.affectedRaw,
        affected_vault: result.affectedVault,
        affected_versions: result.affectedVersions,
        finalized_inline: result.finalizedInline,
      },
      result.finalizedInline
        ? 'revocation complete; affected rows crypto-shredded'
        : 'revocation Phase A complete; run confirm-destruction after the recovery window',
    );
  } finally {
    await pool.end();
    await rawPool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`revoke-key failed: ${String(err)}\n`);
    process.exit(1);
  });
}
