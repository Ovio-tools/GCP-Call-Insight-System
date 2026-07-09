import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRawAppPool, createRawPurgePool } from '../../src/db/raw-store.js';
import {
  isRawPurged,
  insertRawTombstone,
} from '../../src/db/repositories/raw-purge-tombstone-repo.js';
import { hasRawTestDb, TEST_RAW_DATABASE_URL, makeRawPool, migrateRaw } from './_pg.js';
import { cleanupRawCalls } from './_dal.js';

const maybe = hasRawTestDb ? describe : describe.skip;

maybe('raw_purge_tombstone repo', () => {
  const app = createRawAppPool(TEST_RAW_DATABASE_URL as string);
  const purge = createRawPurgePool(TEST_RAW_DATABASE_URL as string);
  const owner = makeRawPool();
  beforeAll(async () => {
    await migrateRaw('up');
  });
  afterEach(async () => {
    await cleanupRawCalls(owner, 'ts-%');
  });
  afterAll(async () => {
    await app.end();
    await purge.end();
    await owner.end();
  });

  it('is false before, true after a tombstone insert (idempotent)', async () => {
    const callId = 'ts-1';
    expect(await isRawPurged(app, callId)).toBe(false);
    await insertRawTombstone(purge, callId, new Date());
    expect(await isRawPurged(app, callId)).toBe(true);
    await insertRawTombstone(purge, callId, new Date()); // ON CONFLICT DO NOTHING
    expect(await isRawPurged(app, callId)).toBe(true);
  });
});
