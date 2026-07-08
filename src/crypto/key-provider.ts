import { hkdfSync } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import { getActiveKeyVersion } from '../db/repositories/key-versions-repo.js';
import { KeyStoreProvider } from './key-store-provider.js';
import { LocalFileKeyStore, type KeyStore } from './key-store.js';
import { RailwayApiSecretBackend } from './railway-api-secret-backend.js';
import { RailwaySecretKeyStore } from './railway-secret-key-store.js';
import { EnvSecretBackend } from './secret-backend.js';

/** Length of an AES-256 data-encryption key (DEK), in bytes. */
export const DEK_BYTES = 32;

/**
 * Source of per-version data-encryption keys.
 *
 * Implementations unwrap the wrapped DEK for a `key_version` using the external KEK —
 * the wrapped material and the KEK live OUTSIDE Postgres (CLAUDE.md §5), so the DEK
 * bytes only ever exist in memory here, never in a column or a backup.
 */
export interface KeyProvider {
  /** Plaintext DEK (32 bytes) for a given key_version. */
  getDek(keyVersion: number): Promise<Buffer>;
  /** The key_version new writes should encrypt under. */
  currentKeyVersion(): Promise<number>;
}

export interface LocalKeyProviderOptions {
  /** High-entropy master secret; at least {@link DEK_BYTES} bytes. */
  masterKey: Buffer;
  /** key_version returned by {@link LocalKeyProvider.currentKeyVersion}. */
  activeKeyVersion: number;
}

/**
 * Dev/test KeyProvider. Derives each per-version DEK deterministically from a local
 * master secret via HKDF — no real KMS, but it exercises the full versioned-key path
 * (distinct DEK per key_version, wrong version fails the GCM tag). NOT for staging or
 * production: the real KMS-backed provider is Task 8.2. Never logs key material.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly #masterKey: Buffer;
  readonly #activeKeyVersion: number;

  constructor(options: LocalKeyProviderOptions) {
    if (options.masterKey.length < DEK_BYTES) {
      throw new Error(`LocalKeyProvider: masterKey must be at least ${DEK_BYTES} bytes`);
    }
    if (!Number.isInteger(options.activeKeyVersion) || options.activeKeyVersion < 1) {
      throw new Error('LocalKeyProvider: activeKeyVersion must be a positive integer');
    }
    this.#masterKey = options.masterKey;
    this.#activeKeyVersion = options.activeKeyVersion;
  }

  getDek(keyVersion: number): Promise<Buffer> {
    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
      return Promise.reject(new Error('LocalKeyProvider: keyVersion must be a positive integer'));
    }
    // HKDF salt is empty; `info` binds the derived key to its version so different
    // versions yield unrelated DEKs.
    const dek = hkdfSync(
      'sha256',
      this.#masterKey,
      Buffer.alloc(0),
      `dek:v${keyVersion}`,
      DEK_BYTES,
    );
    return Promise.resolve(Buffer.from(dek));
  }

  currentKeyVersion(): Promise<number> {
    return Promise.resolve(this.#activeKeyVersion);
  }
}

/** Environments where the local (KMS-less) provider must never be used. */
const NON_LOCAL_ENVS = new Set<Config['NODE_ENV']>(['staging', 'production']);

/** True for providers backed by the external {@link KeyStore} seam (keystore or railway). */
export function isKeyStoreProvider(provider: Config['CRYPTO_KEY_PROVIDER']): boolean {
  return provider === 'keystore' || provider === 'railway';
}

/**
 * Build the configured {@link KeyProvider}. `local` derives keys from
 * `CRYPTO_LOCAL_MASTER_KEY` and is refused in staging/production; `kms` is Task 8.2.
 * Validation lives here (not in the config schema) so services that never encrypt can
 * boot without crypto config — mirroring how DATABASE_URL reachability is the
 * readiness check's job, not the loader's.
 */
export function keyProviderFromConfig(config: Config): KeyProvider {
  if (config.CRYPTO_KEY_PROVIDER === 'kms') {
    throw new Error('CRYPTO_KEY_PROVIDER=kms is not implemented yet (Task 8.2)');
  }
  if (NON_LOCAL_ENVS.has(config.NODE_ENV)) {
    throw new Error(
      `CRYPTO_KEY_PROVIDER=local is forbidden in ${config.NODE_ENV}; use a KMS provider (Task 8.2)`,
    );
  }
  if (!config.CRYPTO_LOCAL_MASTER_KEY) {
    throw new Error('CRYPTO_LOCAL_MASTER_KEY is required when CRYPTO_KEY_PROVIDER=local');
  }
  const masterKey = Buffer.from(config.CRYPTO_LOCAL_MASTER_KEY, 'base64');
  if (masterKey.length < DEK_BYTES) {
    throw new Error(`CRYPTO_LOCAL_MASTER_KEY must decode to at least ${DEK_BYTES} bytes of base64`);
  }
  return new LocalKeyProvider({ masterKey, activeKeyVersion: config.CRYPTO_ACTIVE_KEY_VERSION });
}

/**
 * Build the configured {@link KeyStore} from config. `railway` (`RailwaySecretKeyStore`,
 * Railway-Secrets-backed) is the ONE provider usable in production. `keystore`
 * (`LocalFileKeyStore`) is dev/staging ONLY — the directory IS the external secret store (KEK
 * bytes + wrapped DEK files) — and is refused in production here (no override): the production
 * external KMS beyond `railway` is the blocking follow-up Task 8.2b.
 */
export function keyStoreFromConfig(config: Config): KeyStore {
  if (config.CRYPTO_KEY_PROVIDER === 'railway') {
    return new RailwaySecretKeyStore({
      backend: new EnvSecretBackend({
        [config.CRYPTO_KEK_SECRET_NAME]: config.CRYPTO_KEK_MATERIAL,
        [config.CRYPTO_WRAPPED_DEK_SECRET_NAME]: config.CRYPTO_WRAPPED_DEK_MATERIAL,
      }),
      kekSecretName: config.CRYPTO_KEK_SECRET_NAME,
      dekSecretName: config.CRYPTO_WRAPPED_DEK_SECRET_NAME,
      recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
    });
  }
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'CRYPTO_KEY_PROVIDER=keystore uses LocalFileKeyStore, forbidden in production; the production KMS is Task 8.2b',
    );
  }
  if (!config.CRYPTO_KEY_STORE_DIR) {
    throw new Error('CRYPTO_KEY_STORE_DIR is required when CRYPTO_KEY_PROVIDER=keystore');
  }
  return new LocalFileKeyStore({
    dir: config.CRYPTO_KEY_STORE_DIR,
    recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
  });
}

/**
 * Build a write-capable {@link KeyStore} for the key-lifecycle CLIs
 * (bootstrap/rotate/revoke/confirm-destruction), which MUTATE key material. For `railway` this
 * talks to the Railway GraphQL API (needs RAILWAY_API_TOKEN + env/service ids) via
 * {@link RailwayApiSecretBackend}; running services instead read through the read-only
 * EnvSecretBackend built by {@link keyStoreFromConfig}. For `keystore` it reuses the file store.
 */
export function keyStoreForCli(config: Config): KeyStore {
  if (config.CRYPTO_KEY_PROVIDER === 'railway') {
    if (!config.RAILWAY_API_TOKEN || !config.RAILWAY_ENVIRONMENT_ID || !config.RAILWAY_SERVICE_ID) {
      throw new Error(
        'railway key CLIs require RAILWAY_API_TOKEN, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID',
      );
    }
    return new RailwaySecretKeyStore({
      backend: new RailwayApiSecretBackend({
        token: config.RAILWAY_API_TOKEN,
        environmentId: config.RAILWAY_ENVIRONMENT_ID,
        serviceId: config.RAILWAY_SERVICE_ID,
      }),
      kekSecretName: config.CRYPTO_KEK_SECRET_NAME,
      dekSecretName: config.CRYPTO_WRAPPED_DEK_SECRET_NAME,
      recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
    });
  }
  return keyStoreFromConfig(config);
}

/**
 * Dependency-aware {@link KeyProvider} builder. Unlike {@link keyProviderFromConfig} (config-only,
 * local/dev), the `keystore`/`railway` providers are DB-sourced (single `status='active'` row) so
 * they need a pool — see {@link isKeyStoreProvider}. `keystore` is refused in production (no
 * override — Task 8.2b); `railway` is the ONE provider usable in production; `kms` still throws
 * (8.2b). The `keyStore` may be injected (tests / a shared instance) or is built from config.
 */
export function buildKeyProvider(deps: {
  config: Config;
  pool: Pool;
  keyStore?: KeyStore;
}): KeyProvider {
  const { config, pool } = deps;
  if (config.CRYPTO_KEY_PROVIDER === 'kms') {
    throw new Error(
      'CRYPTO_KEY_PROVIDER=kms is not implemented yet (Task 8.2b: production KMS provider)',
    );
  }
  if (isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    const keyStore = deps.keyStore ?? keyStoreFromConfig(config);
    return new KeyStoreProvider({
      keyStore,
      loadActiveKeyVersion: () => getActiveKeyVersion(pool),
    });
  }
  return keyProviderFromConfig(config);
}
