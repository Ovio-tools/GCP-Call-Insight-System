import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerPool } from '../../src/db/pool.js';
import { createRawOwnerPool } from '../../src/db/raw-store.js';
import {
  hasTestDb,
  TEST_DATABASE_URL,
  hasRawTestDb,
  TEST_RAW_DATABASE_URL,
  migrate,
  migrateRaw,
} from './_pg.js';

const maybe = hasTestDb && hasRawTestDb ? describe : describe.skip;

async function tableExists(pool: import('pg').Pool, name: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`,
    [name],
  );
  return r.rows[0]!.exists;
}

maybe('backup isolation: raw/vault only in DB-B (ADR 0008 Move 2)', () => {
  const a = createOwnerPool(TEST_DATABASE_URL as string);
  const b = createRawOwnerPool(TEST_RAW_DATABASE_URL as string);
  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
  });
  afterAll(async () => {
    await a.end();
    await b.end();
  });

  it('raw_transcripts + token_vault are ABSENT from DB-A', async () => {
    expect(await tableExists(a, 'raw_transcripts')).toBe(false);
    expect(await tableExists(a, 'token_vault')).toBe(false);
  });
  it('raw_transcripts + token_vault + tombstone exist in DB-B', async () => {
    expect(await tableExists(b, 'raw_transcripts')).toBe(true);
    expect(await tableExists(b, 'token_vault')).toBe(true);
    expect(await tableExists(b, 'raw_purge_tombstone')).toBe(true);
  });
  it('DB-A still has the de-identified stores + tombstone absent from DB-A', async () => {
    expect(await tableExists(a, 'clean_transcripts')).toBe(true);
    expect(await tableExists(a, 'structured_knowledge')).toBe(true);
    expect(await tableExists(a, 'raw_purge_tombstone')).toBe(false);
  });
});
