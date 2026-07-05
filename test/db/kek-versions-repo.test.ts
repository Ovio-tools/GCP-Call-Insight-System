import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import {
  getActiveKek,
  insertKek,
  markKekDestroyRequested,
  markKekDestroyed,
} from '../../src/db/repositories/kek-versions-repo.js';

describe.skipIf(!hasTestDb)('kek-versions-repo', () => {
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

  it('insertKek then getActiveKek round-trips the single active KEK', async () => {
    await inTx(async (c) => {
      const row = await insertKek(c, {
        kekVersion: 'kek-a',
        externalKekRef: 'kek:kek-a',
        status: 'active',
      });
      expect(row.kek_version).toBe('kek-a');
      expect(row.external_kek_ref).toBe('kek:kek-a');
      expect(await getActiveKek(c)).toBe('kek-a');
    });
  });

  it('getActiveKek throws when there is no active KEK', async () => {
    await inTx(async (c) => {
      await expect(getActiveKek(c)).rejects.toThrow(/no active/i);
    });
  });

  it('getActiveKek throws when multiple active KEKs exist', async () => {
    await inTx(async (c) => {
      await c.query(`DROP INDEX kek_versions_one_active_idx`);
      await insertKek(c, { kekVersion: 'kek-x', externalKekRef: 'r', status: 'active' });
      await insertKek(c, { kekVersion: 'kek-y', externalKekRef: 'r', status: 'active' });
      await expect(getActiveKek(c)).rejects.toThrow(/active/i);
    });
  });

  it('markKekDestroyRequested persists the approval ref; markKekDestroyed finalizes', async () => {
    await inTx(async (c) => {
      await insertKek(c, { kekVersion: 'kek-z', externalKekRef: 'r', status: 'retired' });
      const until = new Date(Date.parse('2026-06-01T00:00:00Z'));
      await markKekDestroyRequested(c, 'kek-z', {
        recoveryWindowUntil: until,
        approvalRef: 'JIRA-99',
      });
      const req = (
        await c.query<{ destroy_approval_ref: string | null; status: string }>(
          `SELECT destroy_approval_ref, status FROM kek_versions WHERE kek_version='kek-z'`,
        )
      ).rows[0]!;
      expect(req.destroy_approval_ref).toBe('JIRA-99');
      expect(req.status).toBe('retired');

      await markKekDestroyed(c, 'kek-z');
      const done = (
        await c.query<{ status: string; destroyed_at: Date | null }>(
          `SELECT status, destroyed_at FROM kek_versions WHERE kek_version='kek-z'`,
        )
      ).rows[0]!;
      expect(done.status).toBe('destroyed');
      expect(done.destroyed_at).toBeInstanceOf(Date);
    });
  });

  it('markKekDestroyed refuses a KEK that was never destroy-requested', async () => {
    await inTx(async (c) => {
      await insertKek(c, { kekVersion: 'kek-q', externalKekRef: 'r', status: 'retired' });
      await expect(markKekDestroyed(c, 'kek-q')).rejects.toThrow();
    });
  });
});
