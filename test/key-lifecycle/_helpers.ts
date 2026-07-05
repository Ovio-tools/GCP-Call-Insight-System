import type { Pool } from 'pg';
import { encryptUnderVersion, type KeyProvider } from '../../src/crypto/index.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { getActiveKeyVersion } from '../../src/db/repositories/key-versions-repo.js';

/** Test KEK prefix + call_id pattern, so cleanup can find everything this suite created. */
export const KL_KEK_PREFIX = 'kl-kek-';
export const KL_CALL = 'test-kl-';

export function makeStoreProvider(
  dir: string,
  owner: Pool,
  recoveryWindowDays = 0,
): { store: LocalFileKeyStore; provider: KeyProvider & { invalidateActiveVersion(): void } } {
  const store = new LocalFileKeyStore({ dir, recoveryWindowDays });
  const provider = new KeyStoreProvider({
    keyStore: store,
    loadActiveKeyVersion: () => getActiveKeyVersion(owner),
    activeVersionTtlMs: 0, // always re-read; rotation flips the active row mid-run
  });
  return { store, provider };
}

/**
 * Seed an ISOLATED active key hierarchy at a fresh high version: retire whatever is globally
 * active, create a KEK + DEK in the store, and insert an active kek_versions + key_versions row.
 * Returns the new active key_version. No foreign rows exist at this version, so a rotation sweep
 * only touches this suite's data.
 */
export async function seedIsolatedActiveKey(
  owner: Pool,
  store: LocalFileKeyStore,
  kekVersion: string,
): Promise<number> {
  await owner.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
  await store.createKek({ kekVersion });
  await owner.query(
    `INSERT INTO kek_versions (kek_version, status, external_kek_ref) VALUES ($1,'active',$2)`,
    [kekVersion, `kek:${kekVersion}`],
  );
  const v = (
    await owner.query<{ n: number }>(`SELECT COALESCE(MAX(key_version),0)+1 AS n FROM key_versions`)
  ).rows[0]!.n;
  await store.createDek({ keyVersion: v, kekVersion });
  await owner.query(
    `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
     VALUES ($1,'active',$2,$3)`,
    [v, `dek:v${v}`, kekVersion],
  );
  return v;
}

export async function insertEncryptedRaw(
  owner: Pool,
  provider: KeyProvider,
  callId: string,
  version: number,
  plaintext: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO call_state (call_id, source, current_stage, status)
     VALUES ($1,'test','store','completed') ON CONFLICT (call_id) DO NOTHING`,
    [callId],
  );
  const enc = await encryptUnderVersion(
    Buffer.from(plaintext, 'utf8'),
    provider,
    version,
    Buffer.from(callId, 'utf8'),
  );
  await owner.query(
    `INSERT INTO raw_transcripts (call_id, ciphertext, key_version) VALUES ($1,$2,$3)`,
    [callId, enc.ciphertext, version],
  );
}

export async function insertEncryptedVaultToken(
  owner: Pool,
  provider: KeyProvider,
  callId: string,
  token: string,
  version: number,
  plaintext: string,
): Promise<void> {
  const enc = await encryptUnderVersion(
    Buffer.from(plaintext, 'utf8'),
    provider,
    version,
    Buffer.from(callId, 'utf8'),
  );
  await owner.query(
    `INSERT INTO token_vault (call_id, token, ciphertext, key_version) VALUES ($1,$2,$3,$4)`,
    [callId, token, enc.ciphertext, version],
  );
}

/** Remove everything this suite created and restore key_version=1 as the sole active row. */
export async function cleanupKeyLifecycle(owner: Pool): Promise<void> {
  await owner.query(`DELETE FROM raw_transcripts WHERE call_id LIKE $1`, [`${KL_CALL}%`]);
  await owner.query(`DELETE FROM token_vault WHERE call_id LIKE $1`, [`${KL_CALL}%`]);
  await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${KL_CALL}%`]);
  await owner.query(`DELETE FROM key_lifecycle_events WHERE actor LIKE 'kl-%'`);
  await owner.query(`DELETE FROM key_versions WHERE kek_version LIKE $1`, [`${KL_KEK_PREFIX}%`]);
  await owner.query(`DELETE FROM kek_versions WHERE kek_version LIKE $1`, [`${KL_KEK_PREFIX}%`]);
  // Restore the shared seed's single-active invariant for later suites.
  await owner.query(`UPDATE key_versions SET status='active' WHERE key_version=1`);
}
