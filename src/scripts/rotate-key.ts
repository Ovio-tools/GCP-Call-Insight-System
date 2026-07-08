import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createOwnerPool } from '../db/index.js';
import { isKeyStoreProvider, keyStoreForCli } from '../crypto/index.js';
import { KeyStoreProvider } from '../crypto/key-store-provider.js';
import { createRestrictedRunner } from '../db/restricted/restricted-context.js';
import { getActiveKeyVersion } from '../db/repositories/key-versions-repo.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import { createMaintenanceController } from '../key-lifecycle/maintenance-controller.js';
import { rotateKey } from '../key-lifecycle/rotate.js';

/** Fixed confirmation phrase the operator must type to authorize a destructive rotation. */
const CONFIRM_PHRASE = 'ROTATE-KEYS';

/**
 * rotate-key CLI (Task 8.2). Rotates the active DEK: re-encrypts raw+vault onto a new version and
 * crypto-shreds the old one (after the recovery window). DESTRUCTIVE — gated by
 * `CRYPTO_KEY_DESTROY_COMMANDS_ENABLED` (a kill switch, NOT the approval) AND runtime approval:
 * `--actor`, `--approval-ref`, and `--confirm ROTATE-KEYS`. Only `confirmation_matched` is persisted,
 * never the phrase. Runs as the owner login (dev/staging reference; production least-privilege is
 * Task 8.2b). Usage:
 *   node dist/scripts/rotate-key.js --actor ops@x --approval-ref JIRA-123 --confirm ROTATE-KEYS
 */
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      actor: { type: 'string' },
      'approval-ref': { type: 'string' },
      reason: { type: 'string' },
      confirm: { type: 'string' },
    },
  });

  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'rotate-key' });
  if (!isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    throw new Error('rotate-key requires CRYPTO_KEY_PROVIDER=keystore or railway');
  }
  if (!config.CRYPTO_KEY_DESTROY_COMMANDS_ENABLED) {
    throw new Error(
      'rotate-key is disabled (set CRYPTO_KEY_DESTROY_COMMANDS_ENABLED=true to enable)',
    );
  }
  if (values.confirm !== CONFIRM_PHRASE) {
    throw new Error(`rotate-key: pass --confirm ${CONFIRM_PHRASE} to authorize the rotation`);
  }
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createOwnerPool(config.DATABASE_URL);
  const keyStore = keyStoreForCli(config);
  const keyProvider = new KeyStoreProvider({
    keyStore,
    loadActiveKeyVersion: () => getActiveKeyVersion(pool),
  });
  const queueConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  const maintenance = createMaintenanceController({ redis: queueConnection, queue, config });

  try {
    const result = await rotateKey({
      pool,
      restrictedRunner: createRestrictedRunner(pool),
      keyStore,
      keyProvider,
      maintenance,
      config,
      actor: values.actor ?? '',
      ...(values['approval-ref'] ? { approvalRef: values['approval-ref'] } : {}),
      ...(values.reason ? { reason: values.reason } : {}),
      logger,
    });
    logger.info(
      {
        old_key_version: result.oldVersion,
        new_key_version: result.newVersion,
        rows_reencrypted: result.rowsReencrypted,
        finalized_inline: result.finalizedInline,
      },
      result.finalizedInline
        ? 'rotation complete; old key crypto-shredded'
        : 'rotation Phase A complete; run confirm-destruction after the recovery window',
    );
  } finally {
    await queue.close();
    await queueConnection.quit();
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`rotate-key failed: ${String(err)}\n`);
    process.exit(1);
  });
}
