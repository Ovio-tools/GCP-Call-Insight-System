import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { assertKeyLifecycleReady } from '../../src/key-lifecycle/readiness.js';

/**
 * Keystore-mode boot guard (Task 8.2, finding 3): fails before bootstrap (no active KEK/DEK),
 * succeeds once exactly one of each is seeded. Runs in a rolled-back tx for isolation.
 */
describe.skipIf(!hasTestDb)('assertKeyLifecycleReady', () => {
  let owner!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  afterAll(async () => {
    await owner.end();
  });

  async function inTx(body: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await body(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('fails before bootstrap (no active KEK/DEK)', async () => {
    await inTx(async (c) => {
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await expect(assertKeyLifecycleReady(c)).rejects.toThrow(/active KEK/i);
    });
  });

  it('fails with an active DEK but no active KEK', async () => {
    await inTx(async (c) => {
      // Shared DB already has an active key_version (DEK) but kek_versions is empty.
      await expect(assertKeyLifecycleReady(c)).rejects.toThrow(/active KEK/i);
    });
  });

  it('succeeds once exactly one active KEK + DEK are seeded', async () => {
    await inTx(async (c) => {
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await c.query(
        `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
         VALUES ('kek-ready', 'active', 'r')`,
      );
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9700, 'active', 'ref', 'kek-ready')`,
      );
      await expect(assertKeyLifecycleReady(c)).resolves.toBeUndefined();
    });
  });
});
