import { configSchema, type Config } from '../src/config/schema.js';

/**
 * A fully-defaulted `Config` for tests, with `overrides` applied on top.
 *
 * The base is produced by parsing the real schema with only the required `NODE_ENV`, so
 * every defaulted field comes from the single source of truth in `config/schema.ts`. This
 * means adding a new config setting with a default never breaks these test literals — the
 * schema fills it in. Optional-without-default settings (DATABASE_URL, REDIS_URL,
 * CRYPTO_LOCAL_MASTER_KEY, SESSION_SECRET, OIDC_*) stay absent unless a test overrides them.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const base = configSchema.parse({ NODE_ENV: 'test' });
  return { ...base, ...overrides };
}
