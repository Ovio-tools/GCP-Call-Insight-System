import type { Pool } from 'pg';
import { createAppPool } from '../../src/db/index.js';
import { createRawAppPool, createRawRestrictedRunner } from '../../src/db/raw-store.js';
import type { RestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { TEST_DATABASE_URL, TEST_RAW_DATABASE_URL } from './_pg.js';

/** App pool for the tests: connections run as `app_role` (see createAppPool). Used for
 * DAL calls and the role-isolation assertions. Setup/cleanup use the owner `makePool()`. */
export function makeAppPool(): Pool {
  return createAppPool(TEST_DATABASE_URL as string);
}

/** app_role pool on the raw-store (DB-B). */
export function makeRawAppPool(): Pool {
  return createRawAppPool(TEST_RAW_DATABASE_URL as string);
}

/** restricted_role runner (+ its pool) on the raw-store (DB-B). */
export function makeRawRestrictedRunner(): { pool: Pool; runner: RestrictedRunner } {
  return createRawRestrictedRunner(TEST_RAW_DATABASE_URL as string);
}

/**
 * FK-safe cleanup of every row touching a test call_id. Runs on the OWNER pool because
 * `app_role` has no DELETE. Children (which reference call_state / review_queue with
 * ON DELETE RESTRICT) go first, then call_state.
 */
export async function cleanupCalls(owner: Pool, pattern: string): Promise<void> {
  await owner.query(
    `DELETE FROM operator_actions
      WHERE review_queue_id IN (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
    [pattern],
  );
  const childTables = [
    'review_queue',
    'model_invocations',
    'match_keys',
    'clean_transcripts',
    'redaction_findings',
    'extraction_candidates',
    'structured_knowledge',
    'processing_log',
    'dead_letter',
    'backfill_run_calls',
  ];
  for (const table of childTables) {
    await owner.query(`DELETE FROM ${table} WHERE call_id LIKE $1`, [pattern]);
  }
  await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [pattern]);
}

/**
 * Cleanup of every raw-store (DB-B) row touching a test call_id, on the DB-B owner pool.
 * No cross-DB FKs, so order is free — tombstone first for tidiness.
 */
export async function cleanupRawCalls(rawOwner: Pool, pattern: string): Promise<void> {
  for (const table of ['raw_purge_tombstone', 'token_vault', 'raw_transcripts']) {
    await rawOwner.query(`DELETE FROM ${table} WHERE call_id LIKE $1`, [pattern]);
  }
}

/** Seed the local key_versions row that the encrypted tables FK to. */
export async function seedKeyVersion(owner: Pool, keyVersion = 1): Promise<void> {
  await owner.query(
    `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
     VALUES ($1, 'active', 'local:test', 'kek-test')
     ON CONFLICT (key_version) DO NOTHING`,
    [keyVersion],
  );
}
