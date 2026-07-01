import { type KeyProvider, decrypt, encrypt } from '../../crypto/index.js';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import { type PutTokenInput, putTokenInputSchema } from '../schemas/token-vault.js';
import type { RestrictedRunner } from './restricted-context.js';

const TABLE = 'token_vault';

/**
 * Store a token -> value mapping, envelope-encrypted, under the restricted role. AAD
 * binds the ciphertext to its call_id. Idempotent upsert on the composite (call_id,
 * token) key — re-running replaces the ciphertext for that token.
 */
export async function putToken(
  runner: RestrictedRunner,
  keyProvider: KeyProvider,
  input: PutTokenInput,
): Promise<void> {
  const v = parseOrThrow(TABLE, putTokenInputSchema, input);
  const enc = await encrypt(v.plaintext, keyProvider, Buffer.from(v.callId, 'utf8'));
  await runner.run(async (client) => {
    await query(
      client,
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (call_id, token) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         key_version = EXCLUDED.key_version`,
      [v.callId, v.token, enc.ciphertext, enc.keyVersion],
    );
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
