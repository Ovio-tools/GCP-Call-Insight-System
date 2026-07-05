/**
 * Typed data-access layer over the schema (Task 1.2). zod-validated accessors for every
 * table, idempotent per-call writes, an atomic stage-advance, and DB-role-isolated,
 * envelope-encrypted access to the restricted vault tables.
 */
export { createAppPool, createOwnerPool } from './pool.js';
export { withTransaction, withClientTransaction, query, toJsonParam } from './sql.js';
export {
  DalError,
  parseOrThrow,
  DAL_VALIDATION_FAILED,
  DAL_STALE_STAGE,
  DAL_QUERY_FAILED,
  DAL_RESTRICTED_ACCESS_DENIED,
  DAL_COST_ADJUST_REJECTED,
  type DalErrorCode,
} from './errors.js';
export type { JsonValue, Queryable } from './types.js';
export { jsonValueSchema } from './types.js';

export * from './enums.js';
export * from './schemas/index.js';

export * as repositories from './repositories/index.js';
export * as restricted from './restricted/index.js';
