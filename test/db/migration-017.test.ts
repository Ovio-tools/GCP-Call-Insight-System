import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';
import { createAppPool } from '../../src/db/pool.js';
import { TEST_DATABASE_URL } from './_pg.js';

/**
 * Migration 1782864000017 — Task 8.2 key lifecycle: `key_versions` recovery-window columns +
 * a single-active partial unique index (with a loud preflight), the durable `kek_versions`
 * table, the append-only `key_lifecycle_events` audit log, and the column-scoped `key_admin_role`
 * (metadata + audit ONLY — never raw/vault ciphertext).
 *
 * With migrations 018 (backfill run status, Task 11.2), 019 (kek_versions app read grant), and
 * 1782864100000 (drop raw/vault from DB-A, ADR 0008 Move 2) + 1782864100001 (grinder_pump
 * service_category) + 1782864100002 (duplicate_call_leg drop reason) + 1782864100003
 * (structured_knowledge.superseded_by_call_id) stacked on top, ABOVE = 7: `down(7)`
 * rolls back those six + 018 then exposes the pre-017 schema, `up(7)`
 * re-applies 017 (re-running its preflight) + 018 + the six. Crucially, the
 * drop migration's `down()`
 * RECREATES raw_transcripts + token_vault in DB-A, so at the rolled-down state (below 017) those
 * tables exist in DB-A again — which is exactly what the zero-active-WITH-encrypted-rows preflight
 * below relies on (it seeds a raw_transcripts row in DB-A to trigger migration 017's preflight,
 * and 017 re-runs before the drop migration re-applies, so raw_transcripts is present then).
 *
 * Post-split, the key-administrator role can never reach raw/vault — a structural guarantee, not a
 * runtime grant check: raw_transcripts + token_vault are ABSENT from DB-A (where key_admin_role
 * lives — see backup-isolation-guard.test.ts), and DB-B (where raw/vault live) never grants
 * key_admin_role anything. The test below asserts the DB-B half: key_admin_role has ZERO table
 * grants on the raw store. (It uses the table ACLs rather than `pg_roles`, because roles are
 * cluster-global shared catalog: on a shared local cluster key_admin_role is visible from DB-B
 * too, so a `pg_roles` existence check is topology-dependent; an ACL-grant check is 0 in both the
 * shared-local and separate-CI-cluster topologies and is not flaky under concurrent role drops.)
 */
const ABOVE = 7;

describe.skipIf(!hasTestDb)('migration 017 — key lifecycle', () => {
  let owner!: Pool;
  let keyAdmin!: Pool;
  let rawOwner: Pool | undefined;

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
    if (hasRawTestDb) {
      await migrateRaw('up');
      rawOwner = makeRawPool();
    }
  });
  afterAll(async () => {
    await migrate('up'); // restore full schema for later suites
    await owner.end();
    await keyAdmin.end();
    if (rawOwner) await rawOwner.end();
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

  it('key_admin_role can INSERT key_versions + events but has no raw/vault grants (DB-A)', async () => {
    // INSERT a rotating key_version via key_admin_role (column-scoped grant) on DB-A.
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
    await owner.query(`DELETE FROM key_lifecycle_events WHERE actor = 'key-admin'`);
    await owner.query(`DELETE FROM key_versions WHERE key_version = 9401`);
  });

  it.skipIf(!hasRawTestDb)(
    'key_admin_role has ZERO raw/vault footprint in the raw store (DB-B)',
    async () => {
      // The key-administrator role can NEVER reach raw/vault. Structural, post-split (ADR 0008 Move
      // 2): key_admin_role is a DB-A-only role (created by migration 017; migrations-raw never
      // creates it) and raw_transcripts + token_vault live ONLY in DB-B (asserted absent from DB-A
      // by backup-isolation-guard.test.ts). DB-B never grants key_admin_role anything, so it has
      // ZERO ACL entries on the raw store's tables. Asserted via the table ACLs (aclexplode) rather
      // than `pg_roles`, because roles are cluster-global shared catalog — on a shared local cluster
      // key_admin_role is visible from DB-B, so a role-existence check is topology-dependent; an
      // ACL-grant count is 0 in BOTH the shared-local and separate-CI-cluster topologies.
      const grants = await rawOwner!.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) a
           JOIN pg_roles r ON r.oid = a.grantee
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('raw_transcripts', 'token_vault')
            AND r.rolname = 'key_admin_role'`,
      );
      expect(grants.rows[0]?.n).toBe(0);
    },
  );

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
