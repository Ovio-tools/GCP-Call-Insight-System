import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { insertKek } from '../../src/db/repositories/kek-versions-repo.js';
import { rotateKek } from '../../src/key-lifecycle/rotate-kek.js';

describe.skipIf(!hasTestDb)('rotateKek', () => {
  let owner!: Pool;
  let dir: string;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  afterAll(async () => {
    await owner.end();
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rotkek-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

  it('activates a new KEK, retires the old, preserves single-active, and keeps the old unwrapping', async () => {
    await inTx(async (c) => {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      // Old active KEK with a DEK under it.
      await store.createKek({ kekVersion: 'kek-old' });
      await store.createDek({ keyVersion: 8801, kekVersion: 'kek-old' });
      await insertKek(c, { kekVersion: 'kek-old', externalKekRef: 'kek:kek-old', status: 'active' });

      const res = await rotateKek({
        db: c,
        keyStore: store,
        newKekVersion: 'kek-new',
        actor: 'ops',
        approvalRef: 'JIRA-7',
      });
      expect(res.oldKekVersion).toBe('kek-old');
      expect(res.newKekVersion).toBe('kek-new');

      // Exactly one active KEK, and it's the new one.
      const active = (
        await c.query<{ kek_version: string }>(
          `SELECT kek_version FROM kek_versions WHERE status='active'`,
        )
      ).rows;
      expect(active).toHaveLength(1);
      expect(active[0]!.kek_version).toBe('kek-new');
      // Old is retired.
      const old = (
        await c.query<{ status: string }>(
          `SELECT status FROM kek_versions WHERE kek_version='kek-old'`,
        )
      ).rows[0]!;
      expect(old.status).toBe('retired');

      // The retired KEK still unwraps its DEK (not destroyed).
      expect(await store.unwrapDek(8801)).toHaveLength(32);

      // A kek_rotated event was written.
      const ev = (
        await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM key_lifecycle_events WHERE event='kek_rotated' AND kek_version='kek-new'`,
        )
      ).rows[0]!.n;
      expect(ev).toBe(1);
    });
  });
});
