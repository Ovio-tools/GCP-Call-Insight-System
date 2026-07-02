import { accessSync, constants } from 'node:fs';
import type { Config } from '../config/schema.js';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';

/** Validated, decoded redaction settings the stage actually consumes. */
export interface RedactionRuntimeConfig {
  /** Decoded HMAC key for redaction_findings.value_hash (>= 32 bytes). */
  valueHashKey: Buffer;
}

/**
 * REDACTION_VALUE_HASH_KEY is optional at boot (like CRYPTO_LOCAL_MASTER_KEY) but
 * REQUIRED wherever the redaction stage is actually built. Enforced at BOTH
 * boundaries — worker startup (before jobs are consumed) and the redaction handler
 * factory — so backfill/reprocessing code that skips worker.ts still fails fast
 * with a named CONFIG_MISSING_OR_INVALID, never a per-call retry/dead-letter loop.
 *
 * Also verifies REDACTION_DENY_LIST_PATH is readable when set: a configured-but-
 * missing deny list must stop the boot (fail closed), not silently redact without
 * the client's mandatory terms.
 */
export function requireRedactionConfig(config: Config): RedactionRuntimeConfig {
  if (!config.REDACTION_VALUE_HASH_KEY) {
    throw new ConfigError(
      ['REDACTION_VALUE_HASH_KEY'],
      `${CONFIG_ERROR_CODE}: REDACTION_VALUE_HASH_KEY is required to run the redaction stage`,
    );
  }

  if (config.REDACTION_DENY_LIST_PATH !== undefined) {
    try {
      accessSync(config.REDACTION_DENY_LIST_PATH, constants.R_OK);
    } catch {
      throw new ConfigError(
        ['REDACTION_DENY_LIST_PATH'],
        `${CONFIG_ERROR_CODE}: REDACTION_DENY_LIST_PATH is set but not readable`,
      );
    }
  }

  // The zod refinement guarantees canonical base64 of >= 32 decoded bytes.
  return { valueHashKey: Buffer.from(config.REDACTION_VALUE_HASH_KEY, 'base64') };
}
