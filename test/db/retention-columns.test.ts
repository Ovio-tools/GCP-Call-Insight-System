import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

const PURGEABLE = [
  'raw_webhook_events',
  'raw_transcripts',
  'token_vault',
  'clean_transcripts',
  'redaction_findings',
  'match_keys',
  // Migration 9 (extraction_candidates) spreads retentionColumns() directly instead of
  // joining migrations/lib/columns.cjs PURGEABLE_TABLES — appending there would change
  // what migration 5's purge grants consume and break fresh migrations.
  'extraction_candidates',
];
const RETENTION_COLUMNS = ['retention_eligible_at', 'soft_deleted_at', 'hard_deleted_at'];

describe.skipIf(!hasTestDb)('retention columns', () => {
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

  it.each(PURGEABLE)('%s carries all three retention timestamps', async (table) => {
    const cols = await columnsOf(table);
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `${table}.${col}`).toBe(true);
    }
  });

  it('call_state carries none of the retention timestamps', async () => {
    const cols = await columnsOf('call_state');
    for (const col of RETENTION_COLUMNS) {
      expect(cols.has(col), `call_state.${col}`).toBe(false);
    }
  });
});
