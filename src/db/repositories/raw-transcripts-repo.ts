import type { Pool } from 'pg';
import { type KeyProvider, decrypt, encrypt } from '../../crypto/index.js';
import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import { type PutTranscriptInput, putTranscriptInputSchema } from '../schemas/raw-transcripts.js';

const TABLE = 'raw_transcripts';

/**
 * Store the original transcript, envelope-encrypted. `raw_transcripts` is encrypted at
 * rest but is an `app_role` table (not restricted-role-only). AAD binds the ciphertext
 * to its call_id. Idempotent upsert keyed on call_id — a re-fetch re-encrypts under the
 * current key_version.
 *
 * TWO retention-finality guards (Task 8.1 §6), both fail-closed at the writer (the physical
 * held-cap delete leaves NO tombstone, so we cannot rely on callers remembering the preflight):
 *   1. held-cap: a guarded `INSERT ... SELECT ... WHERE NOT EXISTS (a review with raw_purged_at
 *      set)` inserts nothing for a cap-purged call — so a fresh insert after the physical delete
 *      matches zero rows;
 *   2. tombstone: the conflict update is gated `WHERE raw_transcripts.hard_deleted_at IS NULL`,
 *      so a stamp-and-scrub tombstone is never overwritten.
 * Either guard matching zero rows throws `retention conflict` rather than silently succeeding
 * (mirrors `putToken`). `app_role` may read `review_queue`, so the subquery is in-role.
 */
export async function putTranscript(
  pool: Pool,
  keyProvider: KeyProvider,
  input: PutTranscriptInput,
): Promise<void> {
  const v = parseOrThrow(TABLE, putTranscriptInputSchema, input);
  const aad = Buffer.from(v.callId, 'utf8');
  const enc = await encrypt(Buffer.from(v.transcript, 'utf8'), keyProvider, aad);
  const rows = await query(
    pool,
    `INSERT INTO raw_transcripts (call_id, ciphertext, key_version)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM review_queue WHERE call_id = $1 AND raw_purged_at IS NOT NULL
     )
     ON CONFLICT (call_id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       key_version = EXCLUDED.key_version,
       fetched_at = now()
     WHERE raw_transcripts.hard_deleted_at IS NULL
     RETURNING 1 AS ok`,
    [v.callId, enc.ciphertext, enc.keyVersion],
  );
  if (rows.length === 0) {
    throw new DalError(
      DAL_QUERY_FAILED,
      `${DAL_QUERY_FAILED}: ${TABLE} is retention-final (hard-deleted or held-cap purged); fetch may not repopulate it (retention conflict)`,
      { table: TABLE, call_id: v.callId },
    );
  }
}

/**
 * Whether a live (non-deleted) transcript row exists for a call — WITHOUT decrypting it.
 * The transcript-availability gate uses this to confirm fetch-transcript stored something
 * before redact, avoiding a needless decrypt of sensitive content just to check presence.
 */
export async function transcriptExists(pool: Pool, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM raw_transcripts
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  return rows.length > 0;
}

/**
 * Stamp the transcript row retention-eligible (Task 5.3 mark-retention-eligible stage).
 * Metadata only — no decrypt, no content touched; the raw transcript is no longer needed
 * once the de-identified structured_knowledge record exists. Deletion stays in the
 * scheduled retention job (§5), never here.
 *
 * Idempotent + MONOTONIC: only stamps a row whose `retention_eligible_at` is still NULL,
 * so a re-run never resets the purge clock. Never touches a HARD-deleted (retention-final)
 * row. A missing / already-stamped / hard-deleted row is a silent no-op.
 */
export async function markTranscriptRetentionEligible(pool: Pool, callId: string): Promise<void> {
  await query(
    pool,
    `UPDATE raw_transcripts SET retention_eligible_at = now()
      WHERE call_id = $1 AND retention_eligible_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
}

/** Decrypt and return the transcript for a call, or undefined if absent/soft-deleted. */
export async function getTranscript(
  pool: Pool,
  keyProvider: KeyProvider,
  callId: string,
): Promise<string | undefined> {
  const rows = await query<{ ciphertext: Buffer; key_version: number }>(
    pool,
    `SELECT ciphertext, key_version FROM raw_transcripts
      WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [callId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const plaintext = await decrypt(
    { ciphertext: row.ciphertext, keyVersion: row.key_version },
    keyProvider,
    Buffer.from(callId, 'utf8'),
  );
  return plaintext.toString('utf8');
}
