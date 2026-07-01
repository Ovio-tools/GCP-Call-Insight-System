import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

const ROLES = ['app_role', 'restricted_role', 'purge_role'];

/**
 * Guards the cluster-global hazard: a role the migration did NOT create (pre-provisioned
 * by a superuser on locked-down managed Postgres) must survive a full down. down() only
 * drops roles carrying the migration marker, so an unmarked role is left in place.
 *
 * This test owns the role lifecycle itself so it is order-independent; it ends by
 * restoring the normal migrated-up state other DB files expect.
 */
describe.skipIf(!hasTestDb)('pre-provisioned role protection', () => {
  let pool!: Pool;

  async function dropRoles(): Promise<void> {
    for (const role of ROLES) {
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    }
  }

  beforeAll(async () => {
    pool = makePool();
    // Clean slate: unwind the schema (revokes grants, drops any marked roles), then drop
    // any leftover role so we can recreate them as genuinely pre-provisioned (unmarked).
    await migrate('down');
    await dropRoles();
  });

  afterAll(async () => {
    // Restore the state other files assume: no stray unmarked roles, schema migrated up.
    await migrate('down');
    await dropRoles();
    await migrate('up');
    await pool.end();
  });

  it('leaves unmarked pre-provisioned roles in place after a full down', async () => {
    // Pre-provision the three roles WITHOUT the migration marker (as a superuser would).
    for (const role of ROLES) {
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    }

    await migrate('up'); // guarded CREATE ROLE no-ops; no marker is stamped
    await migrate('down'); // full unwind; the role-drop guard must skip unmarked roles

    const res = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [ROLES],
    );
    expect(res.rows.map((r) => r.rolname)).toEqual([...ROLES].sort());
  });
});
