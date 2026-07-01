import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Full reversibility: up → down(all) → up must recreate an identical schema, and a
 * complete down must leave only node-pg-migrate's own bookkeeping table.
 */
describe.skipIf(!hasTestDb)('schema round-trip (up -> down -> up)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Deterministic fingerprint of columns, enum labels, and indexes. */
  async function snapshot(): Promise<string> {
    const columns = await pool.query<Record<string, string | null>>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
        ORDER BY table_name, column_name`,
    );
    const enums = await pool.query<Record<string, string | number>>(
      `SELECT t.typname, e.enumlabel, e.enumsortorder
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        ORDER BY t.typname, e.enumsortorder`,
    );
    const indexes = await pool.query<Record<string, string>>(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'pgmigrations'
        ORDER BY tablename, indexname`,
    );
    // Primary keys, uniques, foreign keys, and checks — with their full definitions,
    // so a dropped/re-added FK or a changed composite PK shows up in the diff.
    const constraints = await pool.query<Record<string, string>>(
      `SELECT rel.relname AS table_name, c.conname, c.contype::text AS contype,
              pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname <> 'pgmigrations'
          AND c.contype IN ('p', 'u', 'f', 'c')
        ORDER BY rel.relname, c.conname`,
    );
    return JSON.stringify({
      columns: columns.rows,
      enums: enums.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
    });
  }

  async function baseTables(): Promise<string[]> {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return res.rows.map((r) => r.table_name);
  }

  it('recreates an identical schema after a full down and up', async () => {
    const before = await snapshot();

    await migrate('down');
    expect(await baseTables()).toEqual(['pgmigrations']);

    await migrate('up');
    const after = await snapshot();
    expect(after).toBe(before);
  });
});
