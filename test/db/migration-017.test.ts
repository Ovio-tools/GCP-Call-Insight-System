import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { createAppPool } from '../../src/db/pool.js';
import { TEST_DATABASE_URL } from './_pg.js';

/**
 * Migration 1782864000017 — Task 8.2 key lifecycle: `key_versions` recovery-window columns +
 * a single-active partial unique index (with a loud preflight), the durable `kek_versions`
 * table, the append-only `key_lifecycle_events` audit log, and the column-scoped `key_admin_role`
 * (metadata + audit ONLY — never raw/vault ciphertext).
 *
 * With migration 018 (backfill run status, Task 11.2) stacked on top, ABOVE = 2: `down(2)` rolls
 * back 018 then exposes the pre-017 schema, `up(2)` re-applies 017 (re-running its preflight) + 018.
 */
const ABOVE = 2;

describe.skipIf(!hasTestDb)('migration 017 — key lifecycle', () => {
  let owner!: Pool;
  let keyAdmin!: Pool;

  /** Snapshot key_versions status so preflight tests can restore shared state exactly. */
  async function snapshotKeyVersions(): Promise<Array<{ key_version: number; status: string }>> {
    const r = await owner.query<{ key_version: number; status: string }>(
      `SELECT key_version, status FROM key_versions ORDER BY key_version`,
    );
    return r.rows;
  }
  async function restoreKeyVersions(
    snap: Array<{ key_version: number; status: string }>,
  ): Promise<void> {
    // Delete rows the test inserted (not in the snapshot), then restore original statuses.
    const keep = snap.map((s) => s.key_version);
    if (keep.length > 0) {
      await owner.query(`DELETE FROM key_versions WHERE key_version <> ALL($1::int[])`, [keep]);
    } else {
      await owner.query(`DELETE FROM key_versions`);
    }
    for (const s of snap) {
      await owner.query(`UPDATE key_versions SET status = $2 WHERE key_version = $1`, [
        s.key_version,
        s.status,
      ]);
    }
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    keyAdmin = createAppPool(TEST_DATABASE_URL as string, 'key_admin_role');
  });
  afterAll(async () => {
    await migrate('up'); // restore full schema for later suites
    await owner.end();
    await keyAdmin.end();
  });

  it('adds the recovery-window columns to key_versions', async () => {
    const r = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'key_versions'
          AND column_name IN
            ('destroy_requested_at','destroy_recovery_window_until','destroy_approval_ref')`,
    );
    expect(r.rows.map((x) => x.column_name).sort()).toEqual([
      'destroy_approval_ref',
      'destroy_recovery_window_until',
      'destroy_requested_at',
    ]);
  });

  it('creates kek_versions with a single-active partial unique index', async () => {
    const cols = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'kek_versions'`,
    );
    const names = cols.rows.map((x) => x.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'kek_version',
        'status',
        'external_kek_ref',
        'destroy_requested_at',
        'destroy_recovery_window_until',
        'destroy_approval_ref',
        'created_at',
        'destroyed_at',
      ]),
    );
    // external_kek_ref, NOT wrapped_ref (a KEK is the wrapping key, not itself wrapped).
    expect(names).not.toContain('wrapped_ref');

    // Single-active partial unique index.
    await owner.query(
      `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
       VALUES ('mig016-kek-a', 'active', 'ref-a')`,
    );
    await expect(
      owner.query(
        `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
         VALUES ('mig016-kek-b', 'active', 'ref-b')`,
      ),
    ).rejects.toThrow(/kek_versions_one_active_idx|duplicate key/i);
    // A retired KEK is outside the partial index → allowed.
    await owner.query(
      `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
       VALUES ('mig016-kek-b', 'retired', 'ref-b')`,
    );
    await owner.query(`DELETE FROM kek_versions WHERE kek_version LIKE 'mig016-kek-%'`);
  });

  it('rejects an invalid kek_versions status via CHECK', async () => {
    await expect(
      owner.query(
        `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
         VALUES ('mig016-bad', 'bogus', 'ref')`,
      ),
    ).rejects.toThrow(/check constraint|kek_versions_status_chk/i);
  });

  it('creates append-only key_lifecycle_events with an event CHECK', async () => {
    await owner.query(
      `INSERT INTO key_lifecycle_events (event, key_version, actor)
       VALUES ('rotate_started', 1, 'mig016')`,
    );
    await expect(
      owner.query(
        `INSERT INTO key_lifecycle_events (event, actor) VALUES ('not_an_event', 'mig016')`,
      ),
    ).rejects.toThrow(/check constraint|key_lifecycle_events_event_chk/i);
    await owner.query(`DELETE FROM key_lifecycle_events WHERE actor = 'mig016'`);
  });

  it('after migration: the partial unique index blocks a second active key_version', async () => {
    const snap = await snapshotKeyVersions();
    try {
      // Ensure exactly one active by retiring any existing actives, then insert one active.
      await owner.query(`UPDATE key_versions SET status = 'retired' WHERE status = 'active'`);
      await owner.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9101, 'active', 'ref', 'kek') ON CONFLICT (key_version) DO NOTHING`,
      );
      await expect(
        owner.query(
          `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
           VALUES (9102, 'active', 'ref', 'kek')`,
        ),
      ).rejects.toThrow(/key_versions_one_active_idx|duplicate key/i);
    } finally {
      await restoreKeyVersions(snap);
    }
  });

  it('preflight: up fails loudly on multiple pre-existing active rows', async () => {
    const snap = await snapshotKeyVersions();
    await migrate('down', ABOVE);
    try {
      // Index is gone below 016 → two actives can coexist to trigger the preflight.
      await owner.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9201, 'active', 'ref', 'kek'), (9202, 'active', 'ref', 'kek')`,
      );
      await expect(migrate('up', ABOVE)).rejects.toThrow(/active/i);
    } finally {
      await owner.query(`DELETE FROM key_versions WHERE key_version IN (9201, 9202)`);
      await migrate('up', ABOVE);
      await restoreKeyVersions(snap);
    }
  });

  it('preflight: up fails on zero-active WITH existing encrypted rows', async () => {
    const snap = await snapshotKeyVersions();
    await migrate('down', ABOVE);
    try {
      await owner.query(`UPDATE key_versions SET status = 'retired' WHERE status = 'active'`);
      await owner.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
         VALUES (9301, 'retired', 'ref', 'kek') ON CONFLICT (key_version) DO NOTHING`,
      );
      await owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ('mig016-enc', 'test', 'redact', 'processing') ON CONFLICT (call_id) DO NOTHING`,
      );
      await owner.query(
        `INSERT INTO raw_transcripts (call_id, ciphertext, key_version)
         VALUES ('mig016-enc', '\\x00'::bytea, 9301)`,
      );
      await expect(migrate('up', ABOVE)).rejects.toThrow(/active|encrypted/i);
    } finally {
      await owner.query(`DELETE FROM raw_transcripts WHERE call_id = 'mig016-enc'`);
      await owner.query(`DELETE FROM call_state WHERE call_id = 'mig016-enc'`);
      await owner.query(`DELETE FROM key_versions WHERE key_version = 9301`);
      await migrate('up', ABOVE);
      await restoreKeyVersions(snap);
    }
  });

  it('preflight: up passes on zero-active with NO encrypted rows (fresh install)', async () => {
    const snap = await snapshotKeyVersions();
    await migrate('down', ABOVE);
    try {
      await owner.query(`UPDATE key_versions SET status = 'retired' WHERE status = 'active'`);
      // No encrypted rows referencing an active key → preflight allows zero-active.
      await expect(migrate('up', ABOVE)).resolves.toBeUndefined();
    } finally {
      await restoreKeyVersions(snap);
    }
  });

  it('key_admin_role can INSERT key_versions + events but has NO raw/vault grants', async () => {
    // INSERT a rotating key_version via key_admin_role (column-scoped grant).
    await keyAdmin.query(
      `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
       VALUES (9401, 'rotating', 'ref', 'kek')`,
    );
    await keyAdmin.query(
      `INSERT INTO key_lifecycle_events (event, key_version, actor)
       VALUES ('rotate_started', 9401, 'key-admin')`,
    );
    // UPDATE status (allowed column).
    await expect(
      keyAdmin.query(`UPDATE key_versions SET status = 'retired' WHERE key_version = 9401`),
    ).resolves.toBeDefined();
    // NO access to raw_transcripts / token_vault.
    await expect(keyAdmin.query(`SELECT ciphertext FROM raw_transcripts LIMIT 1`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(keyAdmin.query(`SELECT ciphertext FROM token_vault LIMIT 1`)).rejects.toThrow(
      /permission denied/i,
    );
    await owner.query(`DELETE FROM key_lifecycle_events WHERE actor = 'key-admin'`);
    await owner.query(`DELETE FROM key_versions WHERE key_version = 9401`);
  });

  it('down removes the 016 objects; up restores them (round-trip)', async () => {
    const snap = await snapshotKeyVersions();
    await migrate('down', ABOVE);
    try {
      const tables = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('kek_versions','key_lifecycle_events')`,
      );
      expect(tables.rows).toHaveLength(0);
      const cols = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'key_versions' AND column_name = 'destroy_requested_at'`,
      );
      expect(cols.rows).toHaveLength(0);
    } finally {
      await migrate('up', ABOVE);
      await restoreKeyVersions(snap);
    }

    // Restored.
    const back = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('kek_versions','key_lifecycle_events')`,
    );
    expect(back.rows).toHaveLength(2);
  });
});
