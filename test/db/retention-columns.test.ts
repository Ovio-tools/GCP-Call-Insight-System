import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';

// The five purgeable stores that remain in DB-A. raw_transcripts + token_vault moved to DB-B
// (ADR 0008 Move 2) and are asserted there separately.
const PURGEABLE_DB_A = [
  'raw_webhook_events',
  'clean_transcripts',
  'redaction_findings',
  'match_keys',
  // Migration 9 (extraction_candidates) spreads retentionColumns() directly instead of
  // joining migrations/lib/columns.cjs PURGEABLE_TABLES — appending there would change
  // what migration 5's purge grants consume and break fresh migrations.
  'extraction_candidates',
];
const PURGEABLE_DB_B = ['raw_transcripts', 'token_vault'];
const RETENTION_COLUMNS = ['retention_eligible_at', 'soft_deleted_at', 'hard_deleted_at'];

describe.skipIf(!hasTestDb)('retention columns', () => {
  let pool!: Pool;
  let rawPool: Pool | undefined;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
    if (hasRawTestDb) {
      await migrateRaw('up');
      rawPool = makeRawPool();
    }
  });
  afterAll(async () => {
    await pool.end();
    if (rawPool) await rawPool.end();
  });

  async function columnsOf(p: Pool, table: string): Promise<Set<string>> {
    const res = await p.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return new Set(res.rows.map((r) => r.column_name));
  }

  it.each(PURGEABLE_DB_A)('%s carries all three retention timestamps (DB-A)', async (table) => {
    const cols = await columnsOf(pool, table);
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `${table}.${col}`).toBe(true);
    }
  });

  it.skipIf(!hasRawTestDb).each(PURGEABLE_DB_B)(
    '%s carries all three retention timestamps (DB-B raw store)',
    async (table) => {
      const cols = await columnsOf(rawPool!, table);
      for (const col of RETENTION_COLUMNS) {
        expect(cols.has(col), `${table}.${col}`).toBe(true);
      }
    },
  );

  it('call_state carries none of the retention timestamps', async () => {
    const cols = await columnsOf(pool, 'call_state');
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `call_state.${col}`).toBe(false);
    }
  });
});
