import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate, TEST_DATABASE_URL } from './_pg.js';
import { createAppPool } from '../../src/db/pool.js';

/**
 * Migration 1782864000019 — grant `app_role` SELECT on `kek_versions`.
 *
 * The keystore boot readiness check (`assertKeyLifecycleReady`, wired into the worker,
 * backfill runner, and sample-validation job) runs `SELECT count(*) FROM kek_versions
 * WHERE status='active'` through the plain app pool (app_role). Migration 017 created
 * `kek_versions` but granted it only to `key_admin_role`, so every keystore-mode service
 * failed to boot with `DAL_RESTRICTED_ACCESS_DENIED` (SQLSTATE 42501). The table holds no
 * key bytes (only `external_kek_ref`, a pointer), so a table-level read grant to app_role
 * is safe — consistent with how the sibling metadata table `key_versions` is treated.
 *
 * 019 is no longer the topmost migration — 1782864100000 (drop raw/vault from DB-A, ADR 0008
 * Move 2) + 1782864100001 (grinder_pump service_category) + 1782864100002 (duplicate_call_leg
 * drop reason) + 1782864100003 (structured_knowledge.superseded_by_call_id) + 1782864100004
 * (below_minimum_duration drop reason) and 1782864100005 (technician_notes + note_feedback,
 * ADR 0009) sit above it: down(7)
 * rolls back those six then exposes the pre-019 schema, up(7) re-applies 019 + all six. (The drop's down() recreates
 * raw/vault in DB-A at the
 * rolled-down state, but this test only touches kek_versions, so that is harmless.)
 */
const ABOVE = 7;

describe.skipIf(!hasTestDb)('migration 019 — kek_versions app read grant', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = createAppPool(TEST_DATABASE_URL as string, 'app_role');
  });
  afterAll(async () => {
    await migrate('up'); // restore full schema for later suites
    await owner.end();
    await app.end();
  });

  it('app_role can SELECT kek_versions (the keystore boot readiness check runs as app_role)', async () => {
    await expect(
      app.query(`SELECT count(*)::int AS n FROM kek_versions WHERE status = 'active'`),
    ).resolves.toBeDefined();
  });

  it('down revokes the grant; up restores it (round-trip)', async () => {
    await migrate('down', ABOVE);
    try {
      await expect(app.query(`SELECT count(*) FROM kek_versions`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await migrate('up', ABOVE);
    }
    // Restored: the grant is back after re-applying 019.
    await expect(app.query(`SELECT count(*) FROM kek_versions`)).resolves.toBeDefined();
  });
});
