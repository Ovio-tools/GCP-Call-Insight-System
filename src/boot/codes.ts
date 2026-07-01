import type { Logger } from 'pino';

/**
 * Forerunner of the Task 2.2 failure model. These three boot-time codes are
 * members of the build-plan §4 root-cause taxonomy; this module ships them ahead
 * of the shared model exactly as the config loader ships CONFIG_MISSING_OR_INVALID.
 * FOLD INTO the Task 2.2 failure-model modules when they land.
 */
export const DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE' as const;
export const REDIS_UNAVAILABLE = 'REDIS_UNAVAILABLE' as const;
export const MIGRATION_FAILED = 'MIGRATION_FAILED' as const;

export type BootErrorCode =
  typeof DATABASE_UNAVAILABLE | typeof REDIS_UNAVAILABLE | typeof MIGRATION_FAILED;

/** Sanitized connection context: host/port/database only. NEVER credentials. */
export interface ConnectionContext {
  host?: string;
  port?: string;
  database?: string;
  /** Set when the failure is a missing environment variable. */
  missing?: string;
}

/**
 * Derive sanitized context from a connection URL. Returns host/port/database only —
 * never userinfo (which holds the password). Empty object if absent/unparseable.
 */
export function sanitizeConnectionContext(url: string | undefined): ConnectionContext {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    return {
      ...(parsed.hostname ? { host: parsed.hostname } : {}),
      ...(parsed.port ? { port: parsed.port } : {}),
      ...(database ? { database } : {}),
    };
  } catch {
    return {};
  }
}

/** A fatal, un-retryable boot failure carrying a stable code and sanitized context. */
export class FatalBootError extends Error {
  readonly code: BootErrorCode;
  readonly context: ConnectionContext;

  constructor(code: BootErrorCode, message: string, context: ConnectionContext = {}) {
    super(message);
    this.name = 'FatalBootError';
    this.code = code;
    this.context = context;
  }
}

export interface FailBootDeps {
  /** Exit hook. Injectable so tests assert the exit without killing the runner. */
  exit?: (code: number) => never;
}

/**
 * Emit exactly one structured fatal line, FLUSH, then exit non-zero. The flush is
 * load-bearing: pino's default destination buffers, so a bare process.exit can drop
 * the line — the opposite of "exits loudly". Pair with {@link createBootLogger},
 * which uses a synchronous destination as the primary guarantee.
 */
export function failBoot(logger: Logger, error: FatalBootError, deps: FailBootDeps = {}): never {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  logger.fatal({ error_code: error.code, context: error.context }, error.message);
  logger.flush();
  return exit(1);
}
