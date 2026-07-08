import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Config } from '../../src/config/schema.js';
import { buildKeyProvider, keyStoreFromConfig } from '../../src/crypto/key-provider.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { LocalKeyProvider, DEK_BYTES } from '../../src/crypto/key-provider.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { RailwaySecretKeyStore } from '../../src/crypto/railway-secret-key-store.js';
import { isKeyStoreProvider } from '../../src/crypto/key-provider.js';
import { makeTestConfig } from '../_config.js';

const VALID_KEY = Buffer.alloc(DEK_BYTES, 0x11).toString('base64');

function cfg(overrides: Partial<Config> = {}): Config {
  return makeTestConfig({
    NODE_ENV: 'development',
    SERVICE_NAME: 'test',
    CRYPTO_LOCAL_MASTER_KEY: VALID_KEY,
    ...overrides,
  });
}

/** A pool stub that resolves the single active key_version. */
const activePool = {
  query: () => Promise.resolve({ rows: [{ key_version: 1 }] }),
} as unknown as Pool;

describe('buildKeyProvider', () => {
  it('builds a LocalKeyProvider for the local provider', () => {
    expect(buildKeyProvider({ config: cfg(), pool: activePool })).toBeInstanceOf(LocalKeyProvider);
  });

  it('builds a KeyStoreProvider for the keystore provider (injected store)', () => {
    const keyStore = new LocalFileKeyStore({
      dir: mkdtempSync(join(tmpdir(), 'b-')),
      recoveryWindowDays: 0,
    });
    const provider = buildKeyProvider({
      config: cfg({ CRYPTO_KEY_PROVIDER: 'keystore' }),
      pool: activePool,
      keyStore,
    });
    expect(provider).toBeInstanceOf(KeyStoreProvider);
  });

  it('refuses the keystore provider in production (Task 8.2b)', () => {
    expect(() =>
      buildKeyProvider({
        config: cfg({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'keystore' }),
        pool: activePool,
      }),
    ).toThrow(/production|8\.2b/i);
  });

  it('still rejects the kms provider (Task 8.2b)', () => {
    expect(() =>
      buildKeyProvider({ config: cfg({ CRYPTO_KEY_PROVIDER: 'kms' }), pool: activePool }),
    ).toThrow(/8\.2b|not implemented/i);
  });
});

describe('keyStoreFromConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ksfc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a LocalFileKeyStore in dev/staging', () => {
    const store = keyStoreFromConfig(cfg({ CRYPTO_KEY_STORE_DIR: dir }));
    expect(store).toBeInstanceOf(LocalFileKeyStore);
  });

  it('refuses in production (no override — production is Task 8.2b)', () => {
    expect(() =>
      keyStoreFromConfig(cfg({ NODE_ENV: 'production', CRYPTO_KEY_STORE_DIR: dir })),
    ).toThrow(/production|8\.2b/i);
  });

  it('requires CRYPTO_KEY_STORE_DIR', () => {
    const { CRYPTO_KEY_STORE_DIR: _omit, ...without } = cfg();
    expect(() => keyStoreFromConfig(without as Config)).toThrow(/CRYPTO_KEY_STORE_DIR/);
  });
});

describe('keyStoreFromConfig — railway', () => {
  it('builds a RailwaySecretKeyStore for provider=railway (production allowed)', () => {
    const config = cfg({
      NODE_ENV: 'production',
      CRYPTO_KEY_PROVIDER: 'railway',
      CRYPTO_KEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
      CRYPTO_WRAPPED_DEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
    });
    const store = keyStoreFromConfig(config);
    expect(store).toBeInstanceOf(RailwaySecretKeyStore);
  });

  it('throws naming CRYPTO_KEK_MATERIAL when railway key material is missing', () => {
    expect(() =>
      keyStoreFromConfig(
        cfg({
          NODE_ENV: 'production',
          CRYPTO_KEY_PROVIDER: 'railway',
          CRYPTO_WRAPPED_DEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
        }),
      ),
    ).toThrow(/CRYPTO_KEK_MATERIAL/);
  });

  it('throws naming CRYPTO_WRAPPED_DEK_MATERIAL when only the KEK material is present', () => {
    expect(() =>
      keyStoreFromConfig(
        cfg({
          NODE_ENV: 'production',
          CRYPTO_KEY_PROVIDER: 'railway',
          CRYPTO_KEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
        }),
      ),
    ).toThrow(/CRYPTO_WRAPPED_DEK_MATERIAL/);
  });

  it('isKeyStoreProvider is true for keystore and railway, false for local/kms', () => {
    expect(isKeyStoreProvider('keystore')).toBe(true);
    expect(isKeyStoreProvider('railway')).toBe(true);
    expect(isKeyStoreProvider('local')).toBe(false);
    expect(isKeyStoreProvider('kms')).toBe(false);
  });
});
