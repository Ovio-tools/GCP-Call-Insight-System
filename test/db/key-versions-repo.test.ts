import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import {
  allocateNextKeyVersion,
  getActiveKeyVersion,
  insertRotatingKeyVersion,
  listVersionsByKek,
  markDestroyRequested,
  markDestroyed,
  updateStatus,
} from '../../src/db/repositories/key-versions-repo.js';

/**
 * key_versions lifecycle ops (Task 8.2). All mutations run inside a transaction that is rolled
 * back, so the shared singleton `key_versions` table is never polluted for other DB suites.
 */
describe.skipIf(!hasTestDb)('key-versions-repo lifecycle', () => {
  let owner!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  afterAll(async () => {
    await owner.end();
  });

  /** Run body in a rolled-back tx with the single-active state controlled from scratch. */
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

  it('getActiveKeyVersion returns the single active row', async () => {
    await inTx(async (c) => {
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9510, 'active', 'ref', 'kek-1')`,
      );
      expect(await getActiveKeyVersion(c)).toBe(9510);
    });
  });

  it('getActiveKeyVersion throws when there is no active row', async () => {
    await inTx(async (c) => {
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await expect(getActiveKeyVersion(c)).rejects.toThrow(/no active/i);
    });
  });

  it('getActiveKeyVersion throws when multiple active rows exist', async () => {
    await inTx(async (c) => {
      // Defense-in-depth: drop the unique index in-tx so the impossible state can be exercised.
      await c.query(`DROP INDEX key_versions_one_active_idx`);
      await c.query(`UPDATE key_versions SET status='retired' WHERE status='active'`);
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9511, 'active', 'ref', 'kek-1'), (9512, 'active', 'ref', 'kek-1')`,
      );
      await expect(getActiveKeyVersion(c)).rejects.toThrow(/active/i);
    });
  });

  it('allocateNextKeyVersion returns MAX+1 without inserting a row', async () => {
    await inTx(async (c) => {
      const before = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM key_versions`)
      ).rows[0]!.n;
      const next = await allocateNextKeyVersion(c);
      const max = (
        await c.query<{ m: number }>(`SELECT COALESCE(MAX(key_version),0)::int AS m FROM key_versions`)
      ).rows[0]!.m;
      expect(next).toBe(max + 1);
      const after = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM key_versions`)
      ).rows[0]!.n;
      expect(after).toBe(before); // no row inserted
    });
  });

  it('insertRotatingKeyVersion inserts a rotating row with the wrapped ref', async () => {
    await inTx(async (c) => {
      const row = await insertRotatingKeyVersion(c, {
        keyVersion: 9520,
        wrappedDekRef: 'dek:v9520',
        kekVersion: 'kek-1',
      });
      expect(row.status).toBe('rotating');
      expect(row.wrapped_dek_ref).toBe('dek:v9520');
    });
  });

  it('updateStatus enforces the from-precondition (guarded transition)', async () => {
    await inTx(async (c) => {
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9530, 'rotating', 'ref', 'kek-1')`,
      );
      // Wrong precondition → no row updated → throws.
      await expect(updateStatus(c, 9530, { from: 'active', to: 'retired' })).rejects.toThrow();
      // Correct precondition → succeeds.
      await updateStatus(c, 9530, { from: 'rotating', to: 'active' });
      const status = (
        await c.query<{ status: string }>(`SELECT status FROM key_versions WHERE key_version=9530`)
      ).rows[0]!.status;
      expect(status).toBe('active');
    });
  });

  it('markDestroyRequested then markDestroyed follow the recovery-window timeline', async () => {
    await inTx(async (c) => {
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9540, 'retired', 'ref', 'kek-1')`,
      );
      const until = new Date(Date.parse('2026-06-01T00:00:00Z'));
      await markDestroyRequested(c, 9540, { recoveryWindowUntil: until, approvalRef: 'JIRA-42' });
      const req = (
        await c.query<{
          destroy_requested_at: Date | null;
          destroy_recovery_window_until: Date | null;
          destroy_approval_ref: string | null;
          status: string;
        }>(`SELECT destroy_requested_at, destroy_recovery_window_until, destroy_approval_ref, status
            FROM key_versions WHERE key_version=9540`)
      ).rows[0]!;
      expect(req.destroy_requested_at).toBeInstanceOf(Date);
      expect(req.destroy_approval_ref).toBe('JIRA-42');
      expect(req.status).toBe('retired'); // still retired until finalized

      await markDestroyed(c, 9540);
      const done = (
        await c.query<{ status: string; destroyed_at: Date | null }>(
          `SELECT status, destroyed_at FROM key_versions WHERE key_version=9540`,
        )
      ).rows[0]!;
      expect(done.status).toBe('destroyed');
      expect(done.destroyed_at).toBeInstanceOf(Date);
    });
  });

  it('markDestroyed refuses a version that was never destroy-requested', async () => {
    await inTx(async (c) => {
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9550, 'retired', 'ref', 'kek-1')`,
      );
      await expect(markDestroyed(c, 9550)).rejects.toThrow();
    });
  });

  it('listVersionsByKek returns every version under a KEK', async () => {
    await inTx(async (c) => {
      await c.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9560, 'retired', 'ref', 'kek-blast'), (9561, 'active', 'ref', 'kek-blast')`,
      );
      const rows = await listVersionsByKek(c, 'kek-blast');
      expect(rows.map((r) => r.key_version).sort()).toEqual([9560, 9561]);
    });
  });
});
