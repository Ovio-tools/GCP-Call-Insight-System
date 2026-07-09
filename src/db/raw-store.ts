import type { Pool } from 'pg';
import { createAppPool, createOwnerPool } from './pool.js';
import { createRestrictedRunner, type RestrictedRunner } from './restricted/restricted-context.js';

/**
 * Raw-store (DB-B) pool factory — thin wrappers over the DB-A pool/runner factories,
 * bound to the isolated raw-transcript connection. Identical role model to DB-A: the
 * restricted runner logs in as `app_role` and does `SET LOCAL ROLE restricted_role`
 * inside a transaction, so the DB-B login user must be a NOINHERIT member of `app_role`,
 * `restricted_role`, and `purge_role` (provisioned in Task 13 / docs/backup-retention.md).
 */

/** app_role pool on DB-B — raw_transcripts reads/writes + tombstone checks. */
export function createRawAppPool(rawDatabaseUrl: string): Pool {
  return createAppPool(rawDatabaseUrl, 'app_role');
}

/** restricted_role runner on DB-B — token_vault reads/writes. */
export function createRawRestrictedRunner(rawDatabaseUrl: string): {
  pool: Pool;
  runner: RestrictedRunner;
} {
  const pool = createAppPool(rawDatabaseUrl, 'app_role');
  return { pool, runner: createRestrictedRunner(pool) };
}

/** purge_role pool on DB-B — retention DELETE + tombstone INSERT. */
export function createRawPurgePool(rawDatabaseUrl: string): Pool {
  return createAppPool(rawDatabaseUrl, 'purge_role');
}

/** Owner pool on DB-B — migrations / test setup only. */
export function createRawOwnerPool(rawDatabaseUrl: string): Pool {
  return createOwnerPool(rawDatabaseUrl);
}
