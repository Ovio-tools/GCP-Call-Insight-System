import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PG_ENUMS } from '../../src/db/enums.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * The DAL mirrors the native pg enum value sets in `src/db/enums.ts` (they can't be
 * imported from the CommonJS migration). This asserts every mirror matches the live
 * `enum_range(...)`, so a migration change to an enum can't silently drift from the DAL.
 */
describe.skipIf(!hasTestDb)('enum parity with the database', () => {
  let pool!: Pool;
  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  for (const [name, values] of Object.entries(PG_ENUMS)) {
    it(`${name} matches enum_range`, async () => {
      const res = await pool.query<{ vals: string[] }>(
        `SELECT enum_range(NULL::${name})::text[] AS vals`,
      );
      expect(res.rows[0]?.vals).toEqual([...values]);
    });
  }
});
