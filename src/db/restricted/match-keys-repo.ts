import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type MatchKeyRow,
  type PutMatchKeysInput,
  matchKeyRowSchema,
  putMatchKeysInputSchema,
} from '../schemas/match-keys.js';
import type { RestrictedRunner } from './restricted-context.js';

const TABLE = 'match_keys';

/**
 * Store the salted HMAC match keys for a call, under the restricted role. These are
 * one-way digests, NOT encrypted values — never decrypted. Idempotent per call via
 * soft-delete-then-insert: a per-call advisory lock serializes concurrent writers, the
 * current active row(s) are soft-deleted, and the new digests inserted. `restricted_role`
 * has no DELETE, and history is retained for the retention cron — "deletes are soft first."
 */
export async function putMatchKeys(
  runner: RestrictedRunner,
  input: PutMatchKeysInput,
): Promise<void> {
  const v = parseOrThrow(TABLE, putMatchKeysInputSchema, input);
  await runner.run(async (client) => {
    // Advisory lock (not a row lock) because restricted_role cannot touch call_state.
    await query(client, `SELECT pg_advisory_xact_lock(hashtext($1))`, [v.callId]);
    await query(
      client,
      `UPDATE match_keys SET soft_deleted_at = now()
        WHERE call_id = $1 AND soft_deleted_at IS NULL`,
      [v.callId],
    );
    await query(
      client,
      `INSERT INTO match_keys (call_id, phone_hmac, name_hmac, key_version)
       VALUES ($1, $2, $3, $4)`,
      [v.callId, v.phoneHmac ?? null, v.nameHmac ?? null, v.keyVersion],
    );
  });
}

/** Active match keys for a call — excludes soft-deleted history rows. Digests, never
 * decrypted. */
export async function getMatchKeys(
  runner: RestrictedRunner,
  callId: string,
): Promise<MatchKeyRow[]> {
  const rows = await runner.run((client) =>
    query<MatchKeyRow>(
      client,
      `SELECT * FROM match_keys
        WHERE call_id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL
        ORDER BY created_at`,
      [callId],
    ),
  );
  return rows.map((r) => parseOrThrow(TABLE, matchKeyRowSchema, r));
}
