import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import { buildKeyProvider, isKeyStoreProvider } from '../crypto/index.js';
import { query } from '../db/sql.js';
import type { Queryable } from '../db/types.js';

/**
 * Keystore-mode boot guard (Task 8.2, finding 3): a service that encrypts under the DB-sourced
 * keystore provider MUST NOT start until exactly one active KEK AND exactly one active DEK
 * (`key_version`) have been seeded by `bootstrap-key`. This fails fast with a named error rather
 * than letting the first encrypt throw mid-pipeline. It is a strict `=== 1` check: zero means
 * "not bootstrapped", more than one means corruption the single-active indexes should prevent.
 */
export async function assertKeyLifecycleReady(db: Queryable): Promise<void> {
  const kek = await query<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM kek_versions WHERE status = 'active'`,
  );
  const dek = await query<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM key_versions WHERE status = 'active'`,
  );
  if (kek[0]!.n !== 1) {
    throw new Error(
      `keystore not ready: expected exactly one active KEK, found ${kek[0]!.n} — run bootstrap-key before starting this service`,
    );
  }
  if (dek[0]!.n !== 1) {
    throw new Error(
      `keystore not ready: expected exactly one active DEK (key_version), found ${dek[0]!.n} — run bootstrap-key before starting this service`,
    );
  }
}

/**
 * Build the key provider a service uses, enforcing the keystore boot guard first. In any
 * DB-sourced-active-version mode (`keystore` or `railway`) it verifies the bootstrap invariant
 * then returns the DB-sourced provider; otherwise it returns the config-only provider (local
 * dev/test).
 */
export async function buildServiceKeyProvider(deps: {
  config: Config;
  pool: Pool;
}): Promise<KeyProvider> {
  if (isKeyStoreProvider(deps.config.CRYPTO_KEY_PROVIDER)) {
    await assertKeyLifecycleReady(deps.pool);
  }
  return buildKeyProvider({ config: deps.config, pool: deps.pool });
}
