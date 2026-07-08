import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { REQUIRED_ENV } from '../_config.js';

const base = { NODE_ENV: 'production', LOG_LEVEL: 'info', ...REQUIRED_ENV };

describe('config — railway key provider', () => {
  it('accepts CRYPTO_KEY_PROVIDER=railway', () => {
    const parsed = configSchema.parse({ ...base, CRYPTO_KEY_PROVIDER: 'railway' });
    expect(parsed.CRYPTO_KEY_PROVIDER).toBe('railway');
  });

  it('defaults the two key-material secret names', () => {
    const parsed = configSchema.parse({ ...base, CRYPTO_KEY_PROVIDER: 'railway' });
    expect(parsed.CRYPTO_KEK_SECRET_NAME).toBe('CRYPTO_KEK_MATERIAL');
    expect(parsed.CRYPTO_WRAPPED_DEK_SECRET_NAME).toBe('CRYPTO_WRAPPED_DEK_MATERIAL');
  });

  it('passes with the distinct default secret names', () => {
    const result = configSchema.safeParse({ ...base, CRYPTO_KEY_PROVIDER: 'railway' });
    expect(result.success).toBe(true);
  });

  it('rejects identical KEK and wrapped-DEK secret names under railway', () => {
    const result = configSchema.safeParse({
      ...base,
      CRYPTO_KEY_PROVIDER: 'railway',
      CRYPTO_KEK_SECRET_NAME: 'SAME_SECRET',
      CRYPTO_WRAPPED_DEK_SECRET_NAME: 'SAME_SECRET',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join('\n');
      expect(msg).toMatch(/CRYPTO_KEK_SECRET_NAME/);
      expect(msg).toMatch(/CRYPTO_WRAPPED_DEK_SECRET_NAME/);
    }
  });

  it('allows identical secret names when the provider is not railway', () => {
    const result = configSchema.safeParse({
      ...base,
      CRYPTO_KEY_PROVIDER: 'local',
      CRYPTO_KEK_SECRET_NAME: 'SAME_SECRET',
      CRYPTO_WRAPPED_DEK_SECRET_NAME: 'SAME_SECRET',
    });
    expect(result.success).toBe(true);
  });
});
