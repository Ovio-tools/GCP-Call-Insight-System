import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import { DEK_BYTES, LocalKeyProvider, keyProviderFromConfig } from '../../src/crypto/index.js';

/** A valid base64 master key (>= 32 decoded bytes). */
const VALID_KEY = Buffer.alloc(DEK_BYTES, 0x11).toString('base64');

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'development',
    DB_CONNECT_TIMEOUT_MS: 5000,
    REDIS_CONNECT_TIMEOUT_MS: 5000,
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'test',
    PORT: 8080,
    CRYPTO_KEY_PROVIDER: 'local',
    CRYPTO_ACTIVE_KEY_VERSION: 1,
    CRYPTO_LOCAL_MASTER_KEY: VALID_KEY,
    WORKER_QUEUE_NAME: 'call-pipeline',
    WORKER_CONCURRENCY: 5,
    WORKER_MAX_ATTEMPTS: 5,
    WORKER_BACKOFF_MS: 1000,
    ALERT_ESCALATION_WINDOW_MINUTES: 15,
    WORKER_KILL_SWITCH: false,
    ...overrides,
  };
}

describe('keyProviderFromConfig', () => {
  it('builds a LocalKeyProvider for a valid local config', () => {
    expect(keyProviderFromConfig(cfg())).toBeInstanceOf(LocalKeyProvider);
  });

  it('rejects the kms provider (Task 8.2)', () => {
    expect(() => keyProviderFromConfig(cfg({ CRYPTO_KEY_PROVIDER: 'kms' }))).toThrow(/Task 8\.2/);
  });

  it('refuses the local provider in staging', () => {
    expect(() => keyProviderFromConfig(cfg({ NODE_ENV: 'staging' }))).toThrow(
      /forbidden in staging/,
    );
  });

  it('refuses the local provider in production', () => {
    expect(() => keyProviderFromConfig(cfg({ NODE_ENV: 'production' }))).toThrow(
      /forbidden in production/,
    );
  });

  it('requires CRYPTO_LOCAL_MASTER_KEY for the local provider', () => {
    // Omit the key entirely (exactOptionalPropertyTypes forbids passing undefined).
    const { CRYPTO_LOCAL_MASTER_KEY: _omit, ...withoutKey } = cfg();
    expect(() => keyProviderFromConfig(withoutKey)).toThrow(/CRYPTO_LOCAL_MASTER_KEY is required/);
  });

  it('rejects a master key that decodes to fewer than 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 0x11).toString('base64');
    expect(() => keyProviderFromConfig(cfg({ CRYPTO_LOCAL_MASTER_KEY: shortKey }))).toThrow(
      /at least 32 bytes/,
    );
  });
});
