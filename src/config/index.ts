import { z } from 'zod';
import { type Config, configSchema } from './schema.js';

export { type Config } from './schema.js';

/** Stable error code surfaced when configuration fails to validate at boot. */
export const CONFIG_ERROR_CODE = 'CONFIG_MISSING_OR_INVALID' as const;

/**
 * Raised when one or more environment variables are missing or invalid.
 *
 * The message and `invalid` list always NAME the offending variable(s), so an
 * operator sees exactly what to fix.
 */
export class ConfigError extends Error {
  readonly code = CONFIG_ERROR_CODE;
  readonly invalid: readonly string[];

  constructor(invalid: readonly string[], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.invalid = invalid;
  }
}

type ValidateResult = { ok: true; config: Config } | { ok: false; error: ConfigError };

/** Variable name for a zod issue, or `<root>` if it has no path. */
function issueVarName(issue: z.ZodIssue): string {
  return issue.path.length > 0 ? String(issue.path[0]) : '<root>';
}

/** Human-readable, variable-named reason for a single issue. */
function issueReason(issue: z.ZodIssue): string {
  const name = issueVarName(issue);
  const missing = issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined';
  return missing ? `${name} is required` : `${name} is invalid (${issue.message})`;
}

/**
 * Pure validation. Returns the typed config or a {@link ConfigError} that names
 * every offending variable. No side effects — safe to call from tests.
 */
export function validateEnv(env: NodeJS.ProcessEnv): ValidateResult {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }

  const issues = parsed.error.issues;
  const invalid = [...new Set(issues.map(issueVarName))];
  const reasons = issues.map(issueReason).join('; ');
  const message = `${CONFIG_ERROR_CODE}: ${reasons}`;

  return { ok: false, error: new ConfigError(invalid, message) };
}

export interface LoadConfigOptions {
  /** Exit hook. Injectable so tests can assert the exit without killing the runner. */
  exit?: (code: number) => never;
  /** Error sink. Defaults to stderr. Injectable for tests / structured logging. */
  onError?: (error: ConfigError) => void;
}

/**
 * Validate configuration at boot. On success returns the typed config; on failure
 * reports the named error and exits the process with a non-zero code.
 *
 * Fail-safe: an invalid environment stops the process here rather than letting the
 * pipeline run on guessed configuration.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const onError =
    options.onError ??
    ((error: ConfigError): void => {
      process.stderr.write(`${error.message}\n`);
    });

  const result = validateEnv(env);
  if (result.ok) {
    return result.config;
  }

  onError(result.error);
  return exit(1);
}
