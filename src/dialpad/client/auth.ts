import type { Config } from '../../config/schema.js';
import { CONFIG_ERROR_CODE, ConfigError } from '../../config/index.js';

/**
 * The Dialpad API key is optional at boot (like DATABASE_URL) but REQUIRED wherever the
 * client is actually built. This fail-fast guard turns a missing key into a
 * `CONFIG_MISSING_OR_INVALID` that NAMES `DIALPAD_API_KEY` at worker / reconciliation-cron
 * startup — never a silent boot that only breaks when the first call runs. Tests that inject
 * a mock `fetchImpl` construct the client without a real key and simply skip this guard.
 */
export function requireDialpadApiKey(config: Config): string {
  if (!config.DIALPAD_API_KEY) {
    throw new ConfigError(
      ['DIALPAD_API_KEY'],
      `${CONFIG_ERROR_CODE}: DIALPAD_API_KEY is required to call the Dialpad API`,
    );
  }
  return config.DIALPAD_API_KEY;
}

/**
 * The single place the Dialpad auth scheme lives. Both a personal app key and an OAuth
 * access token are sent the same way — as a Bearer token — so one helper covers both. The
 * key is read ONLY from validated config and never logged (the redaction guard blocks
 * `api_key`/`token`/`secret` field names).
 */
export function buildDialpadAuthHeaders(config: Config): Record<string, string> {
  return { Authorization: `Bearer ${requireDialpadApiKey(config)}` };
}
