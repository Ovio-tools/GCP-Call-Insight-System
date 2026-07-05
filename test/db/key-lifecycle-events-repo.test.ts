import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import {
  insertLifecycleEvent,
  listLifecycleEvents,
} from '../../src/db/repositories/key-lifecycle-events-repo.js';

describe.skipIf(!hasTestDb)('key-lifecycle-events-repo', () => {
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

  it('appends an event with sanitized metadata and lists it back', async () => {
    await inTx(async (c) => {
      const row = await insertLifecycleEvent(c, {
        event: 'rotate_completed',
        keyVersion: 9600,
        actor: 'ops@example',
        approvalRef: 'JIRA-1',
        confirmationMatched: true,
        affectedRawCount: 3,
        affectedVaultCount: 5,
        rowsReencrypted: 8,
      });
      expect(row.event).toBe('rotate_completed');
      expect(row.confirmation_matched).toBe(true);
      expect(row.rows_reencrypted).toBe(8);

      const listed = await listLifecycleEvents(c, { keyVersion: 9600 });
      expect(listed.some((e) => e.actor === 'ops@example')).toBe(true);
    });
  });

  it('accepts a minimal event (only event + actor)', async () => {
    await inTx(async (c) => {
      const row = await insertLifecycleEvent(c, { event: 'key_bootstrapped', actor: 'boot' });
      expect(row.event).toBe('key_bootstrapped');
      expect(row.key_version).toBeNull();
      expect(row.approval_ref).toBeNull();
    });
  });

  it('rejects an unknown event value', async () => {
    await inTx(async (c) => {
      await expect(
        c.query(`INSERT INTO key_lifecycle_events (event, actor) VALUES ('nope', 'x')`),
      ).rejects.toThrow();
    });
  });
});
