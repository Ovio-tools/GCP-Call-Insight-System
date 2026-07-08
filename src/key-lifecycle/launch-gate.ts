import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import type { KeyStore } from '../crypto/key-store.js';
import { query } from '../db/sql.js';

export interface LaunchGateDeps {
  pool: Pool;
  keyStore: KeyStore;
  config: Config;
  now?: () => Date;
}

export interface LaunchGateResult {
  ok: boolean;
  failures: string[];
}

/**
 * Crypto-shred launch gate (Task 8.2). It keys off `store.recoverability(...)`, NEVER the DB flag,
 * and fails if:
 *   1. any `destroyed` DEK or KEK is still recoverable in the store (the shred is a lie);
 *   2. any destruction was requested, its recovery window elapsed, but it was never finalized
 *      (`destroyed_at` null) — drift the finalizer must resolve;
 *   3. production is running on anything but the Railway-secret key store or a verified external
 *      KMS (local/keystore are dev/staging only — see ADR 0008).
 */
export async function checkLaunchGate(deps: LaunchGateDeps): Promise<LaunchGateResult> {
  const now = deps.now ?? (() => new Date());
  const failures: string[] = [];

  // 3. Production must use the Railway-secret key store or a verified external KMS.
  const productionOk =
    deps.config.CRYPTO_KEY_PROVIDER === 'railway' || deps.config.CRYPTO_KEY_PROVIDER === 'kms';
  if (deps.config.NODE_ENV === 'production' && !productionOk) {
    failures.push(
      `production requires the Railway-secret key store or a verified external KMS (CRYPTO_KEY_PROVIDER=${deps.config.CRYPTO_KEY_PROVIDER}); local/keystore are dev/staging only — ADR 0008`,
    );
  }

  // 1. Destroyed DEKs must be unrecoverable.
  const destroyedDeks = await query<{ key_version: number }>(
    deps.pool,
    `SELECT key_version FROM key_versions WHERE status = 'destroyed'`,
  );
  for (const { key_version: v } of destroyedDeks) {
    const rec = await deps.keyStore.recoverability({ type: 'dek', keyVersion: v });
    if (rec.recoverable) {
      failures.push(`destroyed key_version ${v} is still recoverable in the key store`);
    }
  }

  // 1. Destroyed KEKs must be unrecoverable.
  const destroyedKeks = await query<{ kek_version: string }>(
    deps.pool,
    `SELECT kek_version FROM kek_versions WHERE status = 'destroyed'`,
  );
  for (const { kek_version: k } of destroyedKeks) {
    const rec = await deps.keyStore.recoverability({ type: 'kek', kekVersion: k });
    if (rec.recoverable) {
      failures.push(`destroyed kek_version ${k} is still recoverable in the key store`);
    }
  }

  // 2. Stalled destruction: requested, window elapsed, never finalized.
  const nowMs = now().getTime();
  const stalledDeks = await query<{
    key_version: number;
    destroy_recovery_window_until: Date | null;
  }>(
    deps.pool,
    `SELECT key_version, destroy_recovery_window_until FROM key_versions
      WHERE destroy_requested_at IS NOT NULL AND destroyed_at IS NULL`,
  );
  for (const row of stalledDeks) {
    const until = row.destroy_recovery_window_until;
    if (until && until.getTime() <= nowMs) {
      failures.push(
        `key_version ${row.key_version}: destruction requested and its recovery window elapsed but destroyed_at is null — run confirm-destruction`,
      );
    }
  }
  const stalledKeks = await query<{
    kek_version: string;
    destroy_recovery_window_until: Date | null;
  }>(
    deps.pool,
    `SELECT kek_version, destroy_recovery_window_until FROM kek_versions
      WHERE destroy_requested_at IS NOT NULL AND destroyed_at IS NULL`,
  );
  for (const row of stalledKeks) {
    const until = row.destroy_recovery_window_until;
    if (until && until.getTime() <= nowMs) {
      failures.push(
        `kek_version ${row.kek_version}: destruction requested and its recovery window elapsed but destroyed_at is null — run confirm-destruction`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Throws when the gate fails, with every reason joined — for a CLI/boot hard stop. */
export async function assertLaunchGate(deps: LaunchGateDeps): Promise<void> {
  const result = await checkLaunchGate(deps);
  if (!result.ok) {
    throw new Error(`key-lifecycle launch gate failed:\n- ${result.failures.join('\n- ')}`);
  }
}
