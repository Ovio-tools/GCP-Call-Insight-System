import { afterAll, describe, expect, it } from 'vitest';
import { createRawAppPool, createRawPurgePool } from '../../src/db/raw-store.js';

const RAW_URL = process.env.TEST_RAW_DATABASE_URL;
const maybe = RAW_URL ? describe : describe.skip;

maybe('raw-store pools', () => {
  const appPool = createRawAppPool(RAW_URL!);
  const purgePool = createRawPurgePool(RAW_URL!);
  afterAll(async () => {
    await Promise.all([appPool.end(), purgePool.end()]);
  });

  it('createRawAppPool connects and runs as app_role', async () => {
    const res = await appPool.query<{ role: string }>('SELECT current_user AS role');
    expect(res.rows[0]?.role).toBe('app_role');
  });

  it('createRawPurgePool connects and runs as purge_role', async () => {
    const res = await purgePool.query<{ role: string }>('SELECT current_user AS role');
    expect(res.rows[0]?.role).toBe('purge_role');
  });
});
