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
});
