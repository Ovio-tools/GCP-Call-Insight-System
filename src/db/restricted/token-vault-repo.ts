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
 * recoverable soft delete. A HARD-deleted row is never updated: retention's hard
 * delete is final (crypto-shredding semantics) and redaction must not repopulate
 * it — the guarded conflict matches zero rows and this throws instead of silently
 * succeeding.
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
       VALUES ($1, $2, $3, $4)
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
        `${DAL_QUERY_FAILED}: ${TABLE} row is hard-deleted; redaction may not repopulate it (retention conflict)`,
        { table: TABLE, call_id: v.callId },
      );
    }
  });
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
