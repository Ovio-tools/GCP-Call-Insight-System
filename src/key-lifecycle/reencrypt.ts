import type { Pool } from 'pg';
import type { KeyProvider } from '../crypto/index.js';
import { decrypt, encryptUnderVersion } from '../crypto/index.js';
import { query, withTransaction } from '../db/sql.js';
import type { RestrictedRunner } from '../db/restricted/restricted-context.js';

/**
 * Rotation re-encryption + verify (Task 8.2). Re-encrypts recoverable `raw_transcripts` (app pool)
 * and `token_vault` (restricted runner) ciphertext from the old `key_version` onto the new one,
 * preserving the exact `call_id` AAD. The verify predicate targets RECOVERABLE ciphertext, not a raw
 * count: tombstones keep the old `key_version` forever but with `hard_deleted_at` set and an empty
 * ciphertext, so they must NOT block a rotation. Soft-deleted rows (`soft_deleted_at` set,
 * `hard_deleted_at` null) DO still hold recoverable ciphertext and ARE re-encrypted.
 */
const RECOVERABLE = `key_version = $1 AND hard_deleted_at IS NULL AND octet_length(ciphertext) > 0`;

export interface ReencryptOptions {
  oldVersion: number;
  newVersion: number;
  keyProvider: KeyProvider;
  batch: number;
}

/** Re-encrypt raw_transcripts old→new in `FOR UPDATE` batches. Returns the row count moved. */
export async function reencryptRawTranscripts(pool: Pool, opts: ReencryptOptions): Promise<number> {
  let total = 0;
  for (;;) {
    const moved = await withTransaction(pool, async (client) => {
      const rows = await query<{ call_id: string; ciphertext: Buffer }>(
        client,
        `SELECT call_id, ciphertext FROM raw_transcripts WHERE ${RECOVERABLE}
          ORDER BY call_id LIMIT $2 FOR UPDATE`,
        [opts.oldVersion, opts.batch],
      );
      for (const r of rows) {
        const aad = Buffer.from(r.call_id, 'utf8');
        const plain = await decrypt(
          { ciphertext: r.ciphertext, keyVersion: opts.oldVersion },
          opts.keyProvider,
          aad,
        );
        const enc = await encryptUnderVersion(plain, opts.keyProvider, opts.newVersion, aad);
        await query(
          client,
          `UPDATE raw_transcripts SET ciphertext = $1, key_version = $2
            WHERE call_id = $3 AND key_version = $4`,
          [enc.ciphertext, opts.newVersion, r.call_id, opts.oldVersion],
        );
      }
      return rows.length;
    });
    total += moved;
    if (moved < opts.batch) break;
  }
  return total;
}

/** Re-encrypt token_vault old→new via the restricted runner, in `FOR UPDATE` batches. */
export async function reencryptTokenVault(
  runner: RestrictedRunner,
  opts: ReencryptOptions,
): Promise<number> {
  let total = 0;
  for (;;) {
    const moved = await runner.run(async (client) => {
      const rows = await query<{ call_id: string; token: string; ciphertext: Buffer }>(
        client,
        `SELECT call_id, token, ciphertext FROM token_vault WHERE ${RECOVERABLE}
          ORDER BY call_id, token LIMIT $2 FOR UPDATE`,
        [opts.oldVersion, opts.batch],
      );
      for (const r of rows) {
        const aad = Buffer.from(r.call_id, 'utf8');
        const plain = await decrypt(
          { ciphertext: r.ciphertext, keyVersion: opts.oldVersion },
          opts.keyProvider,
          aad,
        );
        const enc = await encryptUnderVersion(plain, opts.keyProvider, opts.newVersion, aad);
        await query(
          client,
          `UPDATE token_vault SET ciphertext = $1, key_version = $2
            WHERE call_id = $3 AND token = $4 AND key_version = $5`,
          [enc.ciphertext, opts.newVersion, r.call_id, r.token, opts.oldVersion],
        );
      }
      return rows.length;
    });
    total += moved;
    if (moved < opts.batch) break;
  }
  return total;
}

export interface RecoverableCounts {
  raw: number;
  vault: number;
  total: number;
}

/**
 * The verify predicate: count rows with RECOVERABLE ciphertext still at `oldVersion`, across
 * raw_transcripts (app pool) + token_vault (restricted runner). Zero means the rotation/revocation
 * swept everything and it is safe to destroy the old DEK. Runs at least twice per destruction
 * (before destroy-request, and again in the finalizer before markDestroyed).
 */
export async function countRecoverableAtVersion(
  pool: Pool,
  runner: RestrictedRunner,
  oldVersion: number,
): Promise<RecoverableCounts> {
  const raw = (
    await query<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM raw_transcripts WHERE ${RECOVERABLE}`,
      [oldVersion],
    )
  )[0]!.n;
  const vault = await runner.run(async (client) =>
    (
      await query<{ n: number }>(
        client,
        `SELECT count(*)::int AS n FROM token_vault WHERE ${RECOVERABLE}`,
        [oldVersion],
      )
    )[0]!.n,
  );
  return { raw, vault, total: raw + vault };
}
