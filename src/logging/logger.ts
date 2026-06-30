import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { CONTENT_FIELDS, assertNoContentFields } from './redaction.js';

export { RedactionError } from './redaction.js';

/**
 * Safe constant defaults. The logger NEVER reads `process.env` directly: validating
 * configuration is the config loader's job, and reading raw env here would let an
 * invalid value (e.g. a bogus `LOG_LEVEL`) crash pino at import time, before
 * {@link loadConfig} can exit with the named `CONFIG_MISSING_OR_INVALID` error.
 * The real logger is built from validated config in the entrypoint.
 */
const DEFAULT_LEVEL = 'info';
const DEFAULT_SERVICE_NAME = 'gcp-call-insights';

export interface RootLoggerOptions {
  /** pino level. Defaults to the safe constant 'info' — pass validated config. */
  level?: string;
  /** Service name attached to every line. Defaults to the safe service constant. */
  name?: string;
  /** Optional output stream (e.g. for tests). Defaults to stdout. */
  destination?: DestinationStream;
}

/**
 * Build the root logger. JSON structured output. Two layers of content protection:
 *
 *  1. A `logMethod` hook runs the redaction guard on every call's arguments and
 *     THROWS if a known content/PII field is present — leaks fail loudly. Note:
 *     pino only invokes the hook for ENABLED levels, which is the desired contract
 *     — a disabled level emits nothing, so there is nothing to leak.
 *  2. pino `redact` paths mask the same fields as defense-in-depth.
 */
export function createRootLogger(options: RootLoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LEVEL;
  const name = options.name ?? DEFAULT_SERVICE_NAME;

  const pinoOptions: LoggerOptions = {
    level,
    base: { service: name },
    redact: {
      paths: CONTENT_FIELDS.map((field) => `*.${field}`).concat(CONTENT_FIELDS),
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(inputArgs, method) {
        for (const arg of inputArgs) {
          assertNoContentFields(arg);
        }
        return method.apply(this, inputArgs);
      },
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/**
 * Default root logger for early-boot logging (before config load). Built from safe
 * constants only, so importing this module can never crash on bad env. Once config
 * is validated, build the configured logger via {@link createRootLogger} and prefer
 * a per-call logger from {@link createCallLogger}.
 */
export const logger: Logger = createRootLogger();

/**
 * Derive a child logger that stamps `call_id` onto every line, so a single call is
 * traceable across every pipeline stage (build plan §3).
 */
export function createCallLogger(callId: string, parent: Logger = logger): Logger {
  return parent.child({ call_id: callId });
}
