import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Task 8.1 least-privilege grants (migration 013). `purge_role` gets column-scoped SELECT
 * (id/retention-triplet only), column-scoped UPDATE (soft/hard + the scrub columns), DELETE on
 * ONLY `raw_transcripts` + `token_vault` (the held-cap physical delete), and narrow
 * `review_queue` access. Everything else is denied (42501). Requires the TEST_DATABASE_URL user
 * to be a member of the group roles (SET ROLE needs membership) — the CI `postgres` user is.
 */
describe.skipIf(!hasTestDb)('retention purge grants (Task 8.1, migration 013)', () => {
  let pool!: Pool;

  const PERMISSION_DENIED = '42501';

  /** Run `sql` as `role`; returns the SQLSTATE on failure, or undefined on success. Wrapped in
   * a rolled-back transaction so a successful DELETE/UPDATE never actually mutates the DB. */
  async function runAs(role: string, sql: string): Promise<string | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql);
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  const PURGEABLE = [
    'raw_transcripts',
    'token_vault',
    'clean_transcripts',
    'redaction_findings',
    'raw_webhook_events',
    'match_keys',
    'extraction_candidates',
  ];
  const DELETE_ALLOWED = ['raw_transcripts', 'token_vault'];
  const DELETE_DENIED = PURGEABLE.filter((t) => !DELETE_ALLOWED.includes(t));

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('purge_role can SELECT the retention triplet on every purgeable table', async () => {
    for (const table of PURGEABLE) {
      expect(
        await runAs(
          'purge_role',
          `SELECT retention_eligible_at, soft_deleted_at, hard_deleted_at FROM ${table} LIMIT 1`,
        ),
        `SELECT triplet on ${table}`,
      ).toBeUndefined();
    }
  });

  it('purge_role cannot SELECT a content/ciphertext column it may only scrub', async () => {
    expect(await runAs('purge_role', 'SELECT ciphertext FROM raw_transcripts LIMIT 1')).toBe(
      PERMISSION_DENIED,
    );
    expect(await runAs('purge_role', 'SELECT ciphertext FROM token_vault LIMIT 1')).toBe(
      PERMISSION_DENIED,
    );
    expect(await runAs('purge_role', 'SELECT redacted_text FROM clean_transcripts LIMIT 1')).toBe(
      PERMISSION_DENIED,
    );
    expect(await runAs('purge_role', 'SELECT payload FROM raw_webhook_events LIMIT 1')).toBe(
      PERMISSION_DENIED,
    );
  });

  it('purge_role can UPDATE soft/hard/scrub columns', async () => {
    expect(await runAs('purge_role', `UPDATE raw_transcripts SET soft_deleted_at = now()`)).toBeUndefined();
    expect(
      await runAs('purge_role', `UPDATE token_vault SET hard_deleted_at = now(), ciphertext = ''::bytea`),
    ).toBeUndefined();
    expect(
      await runAs(
        'purge_role',
        `UPDATE clean_transcripts SET hard_deleted_at = now(), redacted_text = '', redaction_reasons = '[]'::jsonb`,
      ),
    ).toBeUndefined();
    expect(
      await runAs(
        'purge_role',
        `UPDATE extraction_candidates SET hard_deleted_at = now(), problem_statement = NULL, symptoms = '[]'::jsonb, pii_scan_counts = NULL`,
      ),
    ).toBeUndefined();
  });

  it('purge_role cannot reset retention_eligible_at', async () => {
    expect(await runAs('purge_role', `UPDATE raw_transcripts SET retention_eligible_at = now()`)).toBe(
      PERMISSION_DENIED,
    );
  });

  it('purge_role can DELETE only raw_transcripts and token_vault', async () => {
    for (const table of DELETE_ALLOWED) {
      expect(await runAs('purge_role', `DELETE FROM ${table}`), `DELETE ${table}`).toBeUndefined();
    }
    for (const table of DELETE_DENIED) {
      expect(await runAs('purge_role', `DELETE FROM ${table}`), `DELETE ${table} denied`).toBe(
        PERMISSION_DENIED,
      );
    }
  });

  it('purge_role cannot INSERT into any purgeable table', async () => {
    expect(await runAs('purge_role', `INSERT INTO raw_webhook_events (source) VALUES ('x')`)).toBe(
      PERMISSION_DENIED,
    );
    expect(
      await runAs('purge_role', `INSERT INTO clean_transcripts (call_id, redacted_text) VALUES ('x', 'y')`),
    ).toBe(PERMISSION_DENIED);
  });

  it('purge_role has narrow review_queue access: select id/status/purged, update only raw_purged_at', async () => {
    expect(
      await runAs('purge_role', `SELECT id, call_id, status, created_at, raw_purged_at FROM review_queue LIMIT 1`),
    ).toBeUndefined();
    expect(await runAs('purge_role', `UPDATE review_queue SET raw_purged_at = now()`)).toBeUndefined();
    // Cannot see the sensitive review columns...
    expect(await runAs('purge_role', `SELECT assignee FROM review_queue LIMIT 1`)).toBe(PERMISSION_DENIED);
    expect(await runAs('purge_role', `SELECT held_reason FROM review_queue LIMIT 1`)).toBe(PERMISSION_DENIED);
    expect(await runAs('purge_role', `SELECT sla_due_at FROM review_queue LIMIT 1`)).toBe(PERMISSION_DENIED);
    // ...and cannot change the review status.
    expect(await runAs('purge_role', `UPDATE review_queue SET status = 'resolved'`)).toBe(PERMISSION_DENIED);
  });

  it('restricted_role can read the two non-sensitive review_queue columns (putToken guard)', async () => {
    expect(
      await runAs('restricted_role', `SELECT call_id, raw_purged_at FROM review_queue LIMIT 1`),
    ).toBeUndefined();
  });

  it('purge_role cannot read key material (no decrypt path)', async () => {
    expect(await runAs('purge_role', `SELECT * FROM key_versions LIMIT 1`)).toBe(PERMISSION_DENIED);
  });

  it('migration 013 reverses cleanly (down re-grants DELETE, up re-revokes it)', async () => {
    // down 1: pre-013 state — purge_role can DELETE all purgeable tables again.
    await migrate('down', 1);
    expect(await runAs('purge_role', `DELETE FROM clean_transcripts`)).toBeUndefined();
    // up 1: 013 re-applied — the column-scoped DELETE revoke is back.
    await migrate('up');
    expect(await runAs('purge_role', `DELETE FROM clean_transcripts`)).toBe(PERMISSION_DENIED);
  });
});
