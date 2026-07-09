import { type KeyProvider, decrypt, encrypt } from '../../crypto/index.js';
import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import { type PutTokenInput, putTokenInputSchema } from '../schemas/token-vault.js';
import type { RestrictedRunner } from './restricted-context.js';

const TABLE = 'token_vault';

/**
 * Store a token -> value mapping, envelope-encrypted, under the restricted role. AAD
 * binds the ciphertext to its call_id. Idempotent upsert on the composite (call_id,
 * token) key — re-running replaces the ciphertext for that token and clears a
 * recoverable soft delete.
 *
 * TWO retention-finality guards (crypto-shredding semantics — retention's removal is final and
 * redaction must not repopulate it):
 *   1. DB-B-local tombstone: a guarded `INSERT ... SELECT ... WHERE NOT EXISTS (a
 *      raw_purge_tombstone row)` inserts nothing for a physically-purged call. The held-cap
 *      PHYSICALLY deletes the vault row (leaving only the tombstone), so the write path itself
 *      must fail closed; `restricted_role` has SELECT on `raw_purge_tombstone` in DB-B (Task 4
 *      grants) to evaluate this — no more cross-DB `review_queue` read (ADR 0008 Move 2).
 *   2. hard-delete: the conflict update is gated `WHERE token_vault.hard_deleted_at IS NULL`.
 * Either guard matching zero rows throws instead of silently succeeding. The tombstone is in the
 * SAME DB (DB-B) as this write. Under READ COMMITTED a concurrent purge still leaves a theoretical
 * TOCTOU window, but the tombstone is PERMANENT: once the purge's tombstone insert commits, every
 * subsequent write durably fails closed, so steady-state finality holds.
 */
export async function putToken(
  runner: RestrictedRunner,
  keyProvider: KeyProvider,
  input: PutTokenInput,
): Promise<void> {
  const v = parseOrThrow(TABLE, putTokenInputSchema, input);
  const enc = await encrypt(v.plaintext, keyProvider, Buffer.from(v.callId, 'utf8'));
  await runner.run(async (client) => {
    const rows = await query(
      client,
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_purge_tombstone WHERE call_id = $1
       )
       ON CONFLICT (call_id, token) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         key_version = EXCLUDED.key_version,
         soft_deleted_at = NULL
       WHERE token_vault.hard_deleted_at IS NULL
       RETURNING 1 AS ok`,
      [v.callId, v.token, enc.ciphertext, enc.keyVersion],
    );
    if (rows.length === 0) {
      throw new DalError(
        DAL_QUERY_FAILED,
        `${DAL_QUERY_FAILED}: ${TABLE} is retention-final (hard-deleted or held-cap purged); redaction may not repopulate it (retention conflict)`,
        { table: TABLE, call_id: v.callId },
      );
    }
  });
}

/**
 * Stamp ALL of a call's vault rows retention-eligible (Task 5.3 mark-retention-eligible
 * stage), under the restricted role. Metadata only — no decrypt, no ciphertext touched.
 * The vault is purged with the raw transcript once the de-identified record exists (§2);
 * actual deletion stays in the scheduled retention job.
 *
 * Idempotent + MONOTONIC: only stamps rows whose `retention_eligible_at` is still NULL, so
 * a re-run never resets the purge clock. Never touches a HARD-deleted (crypto-shredded)
 * row. A call with no tokens (no PII detected) stamps zero rows — not an error.
 */
export async function markTokensRetentionEligible(
  runner: RestrictedRunner,
  callId: string,
): Promise<void> {
  await runner.run((client) =>
    query(
      client,
      `UPDATE token_vault SET retention_eligible_at = now()
        WHERE call_id = $1 AND retention_eligible_at IS NULL AND hard_deleted_at IS NULL`,
      [callId],
    ),
  );
}

/**
 * Whether a live (non-deleted) vault row exists for exactly this (call_id, token) — WITHOUT
 * decrypting it (Task 6.2). The review surface's elevated single-value reveal calls this FIRST
 * to reject a token that does not belong to the call before it decrypts, so a reviewer can never
 * pivot one call's reveal into another call's vault value. Restricted-role, metadata-only: it
 * touches no ciphertext and returns only a boolean.
 */
export async function tokenExistsForCall(
  runner: RestrictedRunner,
  input: { callId: string; token: string },
): Promise<boolean> {
  const rows = await runner.run((client) =>
    query<{ one: number }>(
      client,
      `SELECT 1 AS one FROM token_vault
        WHERE call_id = $1 AND token = $2 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL
        LIMIT 1`,
      [input.callId, input.token],
    ),
  );
  return rows.length > 0;
}

/** Decrypt and return the original value for a token, or undefined if absent/soft-deleted. */
export async function getToken(
  runner: RestrictedRunner,
  keyProvider: KeyProvider,
  input: { callId: string; token: string },
): Promise<Buffer | undefined> {
  const rows = await runner.run((client) =>
    query<{ ciphertext: Buffer; key_version: number }>(
      client,
      `SELECT ciphertext, key_version FROM token_vault
        WHERE call_id = $1 AND token = $2 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
      [input.callId, input.token],
    ),
  );
  const row = rows[0];
  if (!row) return undefined;
  return decrypt(
    { ciphertext: row.ciphertext, keyVersion: row.key_version },
    keyProvider,
    Buffer.from(input.callId, 'utf8'),
  );
}
