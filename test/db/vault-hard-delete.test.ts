import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { getToken, putToken } from '../../src/db/restricted/token-vault-repo.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from './_dal.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

const PATTERN = 'test-vhd-%';

/**
 * Retention finality for the vault (Task 4.1 review follow-up): a HARD-deleted
 * token_vault row must never be rewritten by a redaction rerun — the crypto-shred
 * semantics require the ciphertext to stay gone. A SOFT-deleted row is recoverable:
 * a rerun restores it (clears soft_deleted_at).
 */
describe.skipIf(!hasTestDb)('token_vault hard-delete guard', () => {
  let owner!: Pool;
  let app!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  const seed = async (callId: string): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'redact',
      status: 'processing',
    });
    await putToken(createRestrictedRunner(app), keyProvider, {
      callId,
      token: '[NAME_1]',
      plaintext: Buffer.from('John Smith', 'utf8'),
    });
  };

  it('rejects a rewrite of a hard-deleted row and leaves it byte-for-byte unchanged', async () => {
    const callId = 'test-vhd-hard';
    await seed(callId);
    await owner.query(`UPDATE token_vault SET hard_deleted_at = now() WHERE call_id = $1`, [
      callId,
    ]);
    const before = await owner.query(
      `SELECT call_id, token, ciphertext, key_version, soft_deleted_at, hard_deleted_at
         FROM token_vault WHERE call_id = $1`,
      [callId],
    );

    await expect(
      putToken(createRestrictedRunner(app), keyProvider, {
        callId,
        token: '[NAME_1]',
        plaintext: Buffer.from('Someone Else', 'utf8'),
      }),
    ).rejects.toThrow(/hard-deleted/);

    const after = await owner.query(
      `SELECT call_id, token, ciphertext, key_version, soft_deleted_at, hard_deleted_at
         FROM token_vault WHERE call_id = $1`,
      [callId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('restores a soft-deleted row on rerun (clears soft_deleted_at, replaces ciphertext)', async () => {
    const callId = 'test-vhd-soft';
    await seed(callId);
    await owner.query(`UPDATE token_vault SET soft_deleted_at = now() WHERE call_id = $1`, [
      callId,
    ]);
    // getToken excludes soft-deleted rows.
    const runner = createRestrictedRunner(app);
    expect(await getToken(runner, keyProvider, { callId, token: '[NAME_1]' })).toBeUndefined();

    await putToken(runner, keyProvider, {
      callId,
      token: '[NAME_1]',
      plaintext: Buffer.from('John Smith', 'utf8'),
    });

    const restored = await getToken(runner, keyProvider, { callId, token: '[NAME_1]' });
    expect(restored?.toString('utf8')).toBe('John Smith');
  });
});
