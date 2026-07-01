import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider, decrypt, encrypt } from '../../src/crypto/index.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * End-to-end: encrypt a value with the envelope helper, store ciphertext + key_version
 * in token_vault, read it back, and decrypt. Also proves the composite (call_id, token)
 * PK lets the same token label live under two different calls.
 */
describe.skipIf(!hasTestDb)('encrypted row round-trip', () => {
  let pool!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
    await pool.query(
      `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
       VALUES (1, 'active', 'local:test', 'kek-test')
       ON CONFLICT (key_version) DO NOTHING`,
    );
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM token_vault WHERE call_id LIKE 'test-enc-%'`);
    await pool.query(`DELETE FROM call_state WHERE call_id LIKE 'test-enc-%'`);
    await pool.end();
  });

  async function insertCall(callId: string): Promise<void> {
    await pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'store', 'complete')
       ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  it('stores and decrypts an envelope-encrypted vault value', async () => {
    const callId = 'test-enc-1';
    await insertCall(callId);
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
      await insertCall(id);
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
