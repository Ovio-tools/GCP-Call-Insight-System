import { DAL_QUERY_FAILED, DalError, parseOrThrow } from '../errors.js';
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
 *
 * Retention (Task 8.1): `match_keys` is a PURGEABLE table with its own short window, so the
 * writer stamps `retention_eligible_at` at insert (its clock starts at write — there is no later
 * stage to stamp it, and an unstamped row would be immortal to the purge predicate). It also
 * preserves hard-delete finality: a call with a hard-deleted (crypto-shredded) match_keys
 * tombstone must never get a fresh key — the guarded preflight throws instead of repopulating.
 */
export async function putMatchKeys(
  runner: RestrictedRunner,
  input: PutMatchKeysInput,
): Promise<void> {
  const v = parseOrThrow(TABLE, putMatchKeysInputSchema, input);
  await runner.run(async (client) => {
    // Advisory lock (not a row lock) because restricted_role cannot touch call_state.
    await query(client, `SELECT pg_advisory_xact_lock(hashtext($1))`, [v.callId]);
    // Finality guard: a hard-deleted match_keys tombstone for this call is retention-final.
    const tombstone = await query<{ one: number }>(
      client,
      `SELECT 1 AS one FROM match_keys WHERE call_id = $1 AND hard_deleted_at IS NOT NULL LIMIT 1`,
      [v.callId],
    );
    if (tombstone.length > 0) {
      throw new DalError(
        DAL_QUERY_FAILED,
        `${DAL_QUERY_FAILED}: ${TABLE} is retention-final (hard-deleted); matching may not repopulate it (retention conflict)`,
        { table: TABLE, call_id: v.callId },
      );
    }
    await query(
      client,
      `UPDATE match_keys SET soft_deleted_at = now()
        WHERE call_id = $1 AND soft_deleted_at IS NULL`,
      [v.callId],
    );
    await query(
      client,
      `INSERT INTO match_keys (call_id, phone_hmac, name_hmac, key_version, retention_eligible_at)
       VALUES ($1, $2, $3, $4, now())`,
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
