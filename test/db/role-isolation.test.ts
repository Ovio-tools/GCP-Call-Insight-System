import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Requires the TEST_DATABASE_URL user to be a superuser / member of the group roles
 * (SET ROLE needs membership). The CI Postgres service's `postgres` user satisfies it.
 */
describe.skipIf(!hasTestDb)('role isolation', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  /** SELECT one row from `table` as `role`; returns the SQLSTATE on failure. */
  async function selectAs(role: string, table: string): Promise<string | undefined> {
    const client = await pool.connect();
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
    expect(await selectAs('app_role', 'token_vault')).toBe(PERMISSION_DENIED);
  });

  it('app_role cannot read match_keys', async () => {
    expect(await selectAs('app_role', 'match_keys')).toBe(PERMISSION_DENIED);
  });

  it('restricted_role can read token_vault', async () => {
    expect(await selectAs('restricted_role', 'token_vault')).toBeUndefined();
  });

  it('restricted_role can read match_keys', async () => {
    expect(await selectAs('restricted_role', 'match_keys')).toBeUndefined();
  });

  it('app_role can still read a working table', async () => {
    expect(await selectAs('app_role', 'call_state')).toBeUndefined();
  });
});
