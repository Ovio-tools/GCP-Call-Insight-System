import { z } from 'zod';

/**
 * Forerunner of the Task 2.2 failure model, in the exact spirit of `src/boot/codes.ts`
 * and the config loader's `CONFIG_MISSING_OR_INVALID`: a small set of stable codes and
 * a sanitized-context error shipped ahead of the shared model. FOLD INTO the Task 2.2
 * failure-model modules when they land — do NOT grow an alerting / dedup / severity
 * layer here (that is 2.2's job).
 *
 * `context` carries only sanitized identifiers (table / column names, `call_id`,
 * SQLSTATE). NEVER row values, transcript content, or PII.
 */
export const DAL_VALIDATION_FAILED = 'DAL_VALIDATION_FAILED' as const;
export const DAL_STALE_STAGE = 'DAL_STALE_STAGE' as const;
export const DAL_QUERY_FAILED = 'DAL_QUERY_FAILED' as const;
export const DAL_RESTRICTED_ACCESS_DENIED = 'DAL_RESTRICTED_ACCESS_DENIED' as const;

export type DalErrorCode =
  | typeof DAL_VALIDATION_FAILED
  | typeof DAL_STALE_STAGE
  | typeof DAL_QUERY_FAILED
  | typeof DAL_RESTRICTED_ACCESS_DENIED;

/** Postgres `insufficient_privilege`; a query the current role isn't granted. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';

/** A data-access failure carrying a stable code and sanitized context. */
export class DalError extends Error {
  readonly code: DalErrorCode;
  readonly context: Record<string, string>;

  constructor(code: DalErrorCode, message: string, context: Record<string, string> = {}) {
    super(message);
    this.name = 'DalError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Build a {@link DalError} from a zod failure. Records the offending column names (the
 * issue paths) but NEVER the values — a rejected value could be PII.
 */
export function validationError(table: string, error: z.ZodError): DalError {
  const columns = [
    ...new Set(error.issues.map((i) => (i.path.length ? String(i.path[0]) : '<row>'))),
  ];
  return new DalError(
    DAL_VALIDATION_FAILED,
    `${DAL_VALIDATION_FAILED}: ${table} (${columns.join(', ')})`,
    {
      table,
      columns: columns.join(','),
    },
  );
}

/**
 * Validate `input` against `schema`, throwing a sanitized {@link DalError} (naming the
 * offending columns, never the values) on failure. Used on every write input and every
 * row read back, so a boundary violation surfaces as a stable code, not a raw ZodError.
 */
export function parseOrThrow<T>(table: string, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(table, result.error);
  }
  return result.data;
}

/** SQLSTATE from a pg error, if present. */
export function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}
