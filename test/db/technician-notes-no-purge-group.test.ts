import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * ADR 0009: `technician_notes` is a DURABLE store — it joins `structured_knowledge` as knowledge
 * that is kept, not cleaned up. `note_feedback` likewise holds nothing purgeable.
 *
 * This is the guard that keeps that true. `src/retention/purge.ts` registers every purgeable table
 * by name, so a source scan is a complete check: if neither name appears there, neither table can
 * be in any group, on any window, under any code path. A contributor who registers one must delete
 * this test on purpose — which is the point.
 *
 * The behavioural half (a real dry run reports zero rows for both) lives in
 * `test/retention/purge.test.ts`, where the two-pool purge harness already exists.
 */
const PURGE_SRC = fileURLToPath(new URL('../../src/retention/purge.ts', import.meta.url));
const RUN_SRC = fileURLToPath(new URL('../../src/retention/run.ts', import.meta.url));

const DURABLE_TABLES = ['technician_notes', 'note_feedback'];
const RETENTION_COLUMNS = ['retention_eligible_at', 'soft_deleted_at', 'hard_deleted_at'];

describe('technician_notes / note_feedback are in no purge group', () => {
  it.each(DURABLE_TABLES)('%s is never named in src/retention/purge.ts', (table) => {
    const src = readFileSync(PURGE_SRC, 'utf8');
    expect(src).not.toContain(table);
  });

  it.each(DURABLE_TABLES)('%s is never named in src/retention/run.ts', (table) => {
    const src = readFileSync(RUN_SRC, 'utf8');
    expect(src).not.toContain(table);
  });

  it('the guard is reading a file that really does register purgeable tables', () => {
    // Without this, a moved or renamed purge module would make the assertions above pass
    // vacuously — they would be scanning a file that names no tables at all.
    const src = readFileSync(PURGE_SRC, 'utf8');
    expect(src).toContain('extraction_candidates');
    expect(src).toContain('clean_transcripts');
    expect(src).toContain("group: 'EXTRACT'");
  });
});

describe.skipIf(!hasTestDb)('durable-table retention column shape', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function columnsOf(table: string): Promise<Set<string>> {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return new Set(res.rows.map((r) => r.column_name));
  }

  it('technician_notes carries all three retention timestamps even though nothing purges it', async () => {
    // Deliberate (ADR 0009): keeping the shape means a future policy change is a one-line
    // registration in the cron, not a migration against a populated table.
    const cols = await columnsOf('technician_notes');
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `technician_notes.${col}`).toBe(true);
    }
  });

  it('technician_notes retention timestamps are never set by anything', async () => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM technician_notes
        WHERE retention_eligible_at IS NOT NULL
           OR soft_deleted_at IS NOT NULL
           OR hard_deleted_at IS NOT NULL`,
    );
    expect(res.rows[0]!.n).toBe(0);
  });

  it('note_feedback carries none of the retention timestamps', async () => {
    const cols = await columnsOf('note_feedback');
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `note_feedback.${col}`).toBe(false);
    }
  });

  it('purge_role can read technician_notes but was granted no DELETE', async () => {
    // Grants are pre-provisioned (ADR 0009) so a policy reversal stays a registration. They are
    // dormant: no group references the table. DELETE is absent because a hypothetical future
    // purge here would be stamp-and-scrub, matching every other DB-A table.
    const res = await pool.query<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'technician_notes' AND grantee = 'purge_role'`,
    );
    const privileges = res.rows.map((r) => r.privilege_type).sort();
    expect(privileges).toEqual(['SELECT', 'UPDATE']);
  });
});
