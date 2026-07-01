import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { repositories, restricted } from '../../src/db/index.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from './_dal.js';

const PATTERN = 'test-iso-%';
const PERMISSION_DENIED = '42501';

/**
 * The privacy boundary is DB-enforced: ordinary DAL connections run as app_role and
 * cannot touch the vault tables; only the restricted context can, and it round-trips
 * token_vault through envelope encryption while match_keys stays a one-way HMAC digest.
 */
describe.skipIf(!hasTestDb)('vault / match-key isolation', () => {
  let owner!: Pool;
  let app!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });
  const runner = () => restricted.createRestrictedRunner(app);

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('app pool connections run as app_role', async () => {
    const res = await app.query<{ role: string }>(`SELECT current_role AS role`);
    expect(res.rows[0]?.role).toBe('app_role');
  });

  it('app_role cannot read token_vault (42501)', async () => {
    await expect(app.query(`SELECT * FROM token_vault LIMIT 1`)).rejects.toMatchObject({
      code: PERMISSION_DENIED,
    });
  });

  it('app_role cannot read match_keys (42501)', async () => {
    await expect(app.query(`SELECT * FROM match_keys LIMIT 1`)).rejects.toMatchObject({
      code: PERMISSION_DENIED,
    });
  });

  it('token_vault round-trips plaintext through the restricted, encrypted path', async () => {
    const callId = 'test-iso-vault';
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'redact',
      status: 'processing',
    });
    const secret = Buffer.from('(555) 123-4567', 'utf8');
    await restricted.tokenVault.putToken(runner(), keyProvider, {
      callId,
      token: '[PHONE_1]',
      plaintext: secret,
    });
    const back = await restricted.tokenVault.getToken(runner(), keyProvider, {
      callId,
      token: '[PHONE_1]',
    });
    expect(back?.equals(secret)).toBe(true);
    // Stored bytes are ciphertext, not the plaintext.
    const raw = await owner.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM token_vault WHERE call_id = $1 AND token = $2`,
      [callId, '[PHONE_1]'],
    );
    expect(raw.rows[0]?.ciphertext.includes(secret)).toBe(false);
  });

  it('match_keys stores HMAC digests byte-for-byte, never decrypted', async () => {
    const callId = 'test-iso-mk';
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    const phoneHmac = Buffer.from('0123456789abcdef', 'hex');
    const nameHmac = Buffer.from('fedcba9876543210', 'hex');
    await restricted.matchKeys.putMatchKeys(runner(), {
      callId,
      phoneHmac,
      nameHmac,
      keyVersion: 1,
    });
    const rows = await restricted.matchKeys.getMatchKeys(runner(), callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone_hmac?.equals(phoneHmac)).toBe(true);
    expect(rows[0]?.name_hmac?.equals(nameHmac)).toBe(true);
  });
});
