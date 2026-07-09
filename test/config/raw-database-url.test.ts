import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { REQUIRED_ENV } from '../_config.js';

// REQUIRED_ENV supplies the review-queue + retention fields that have no schema default;
// without them the base object never parses, so RAW_DATABASE_URL could not be exercised.
const base = { NODE_ENV: 'test', LOG_LEVEL: 'info', ...REQUIRED_ENV };

describe('config — RAW_DATABASE_URL', () => {
  it('accepts an optional RAW_DATABASE_URL', () => {
    const parsed = configSchema.parse({ ...base, RAW_DATABASE_URL: 'postgres://x' });
    expect(parsed.RAW_DATABASE_URL).toBe('postgres://x');
  });
  it('leaves it undefined when unset', () => {
    const parsed = configSchema.parse({ ...base });
    expect(parsed.RAW_DATABASE_URL).toBeUndefined();
  });
  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('RAW_DATABASE_URL');
  });
});
