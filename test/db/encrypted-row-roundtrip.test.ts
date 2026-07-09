import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider, decrypt, encrypt } from '../../src/crypto/index.js';
import { hasRawTestDb, makeRawPool, migrateRaw } from './_pg.js';

/**
 * End-to-end: encrypt a value with the envelope helper, store ciphertext + key_version
 * in token_vault, read it back, and decrypt. Also proves the composite (call_id, token)
 * PK lets the same token label live under two different calls.
 *
 * token_vault now lives in the isolated raw store (DB-B, ADR 0008 Move 2), which has NO cross-DB
 * FK to call_state / key_versions — so this seeds the vault directly, no call_state/key_versions
 * row required.
 */
describe.skipIf(!hasRawTestDb)('encrypted row round-trip', () => {
  let pool!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  beforeAll(async () => {
    await migrateRaw('up');
    pool = makeRawPool();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM token_vault WHERE call_id LIKE 'test-enc-%'`);
    await pool.end();
  });

  it('stores and decrypts an envelope-encrypted vault value', async () => {
    const callId = 'test-enc-1';
    const original = '(555) 123-4567';
    const aad = Buffer.from(callId, 'utf8');

    const enc = await encrypt(Buffer.from(original, 'utf8'), keyProvider, aad);
    await pool.query(
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version) VALUES ($1, $2, $3, $4)`,
      [callId, '[PHONE_1]', enc.ciphertext, enc.keyVersion],
    );

    const res = await pool.query<{ ciphertext: Buffer; key_version: number }>(
      `SELECT ciphertext, key_version FROM token_vault WHERE call_id = $1 AND token = $2`,
      [callId, '[PHONE_1]'],
    );
    const row = res.rows[0];
    expect(row).toBeDefined();
    const back = await decrypt(
      { ciphertext: row!.ciphertext, keyVersion: row!.key_version },
      keyProvider,
      aad,
    );
    expect(back.toString('utf8')).toBe(original);
  });

  it('lets two different calls store the same token label without collision', async () => {
    const ids = ['test-enc-a', 'test-enc-b'];
    for (const id of ids) {
      const enc = await encrypt(Buffer.from(`name-${id}`, 'utf8'), keyProvider, Buffer.from(id));
      await pool.query(
        `INSERT INTO token_vault (call_id, token, ciphertext, key_version) VALUES ($1, $2, $3, $4)`,
        [id, '[NAME_1]', enc.ciphertext, enc.keyVersion],
      );
    }
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_vault
        WHERE token = '[NAME_1]' AND call_id = ANY($1)`,
      [ids],
    );
    expect(res.rows[0]?.n).toBe('2');
  });
});
