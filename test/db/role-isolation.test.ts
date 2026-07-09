import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';

/**
 * Requires the TEST_DATABASE_URL user to be a superuser / member of the group roles
 * (SET ROLE needs membership). The CI Postgres service's `postgres` user satisfies it.
 *
 * ADR 0008 Move 2: token_vault now lives in the isolated raw store (DB-B), so its role checks
 * run against the DB-B superuser connection (SET ROLE works there too). match_keys + call_state
 * stay in DB-A and are checked on the DB-A connection.
 */
describe.skipIf(!hasTestDb || !hasRawTestDb)('role isolation', () => {
  let pool!: Pool;
  let rawPool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    pool = makePool();
    rawPool = makeRawPool();
  });
  afterAll(async () => {
    await pool.end();
    await rawPool.end();
  });

  /** SELECT one row from `table` as `role` on `p`; returns the SQLSTATE on failure. */
  async function selectAs(p: Pool, role: string, table: string): Promise<string | undefined> {
    const client = await p.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await client.query(`SELECT * FROM ${table} LIMIT 1`);
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  }

  const PERMISSION_DENIED = '42501';

  it('app_role cannot read token_vault', async () => {
    expect(await selectAs(rawPool, 'app_role', 'token_vault')).toBe(PERMISSION_DENIED);
  });

  it('app_role cannot read match_keys', async () => {
    expect(await selectAs(pool, 'app_role', 'match_keys')).toBe(PERMISSION_DENIED);
  });

  it('restricted_role can read token_vault', async () => {
    expect(await selectAs(rawPool, 'restricted_role', 'token_vault')).toBeUndefined();
  });

  it('restricted_role can read match_keys', async () => {
    expect(await selectAs(pool, 'restricted_role', 'match_keys')).toBeUndefined();
  });

  it('app_role can still read a working table', async () => {
    expect(await selectAs(pool, 'app_role', 'call_state')).toBeUndefined();
  });
});
