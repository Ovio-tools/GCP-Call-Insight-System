import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from '../db/_pg.js';
import { makeTestConfig } from '../_config.js';
import { checkLaunchGate } from '../../src/key-lifecycle/launch-gate.js';
import {
  KL_KEK_PREFIX,
  cleanupKeyLifecycle,
  makeStoreProvider,
  seedIsolatedActiveKey,
} from './_helpers.js';

let seq = 0;

describe.skipIf(!hasTestDb || !hasRawTestDb)('checkLaunchGate', () => {
  let owner!: Pool;
  let rawOwner!: Pool;
  const dev = makeTestConfig({ NODE_ENV: 'development', CRYPTO_KEY_PROVIDER: 'keystore' });

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    owner = makePool();
    rawOwner = makeRawPool();
  });
  afterAll(async () => {
    await owner.end();
    await rawOwner.end();
  });
  beforeEach(async () => {
    await cleanupKeyLifecycle(owner, rawOwner);
  });
  afterEach(async () => {
    await cleanupKeyLifecycle(owner, rawOwner);
  });

  it('passes with no destroyed keys in dev', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, `${KL_KEK_PREFIX}${seq}`);
      const res = await checkLaunchGate({ pool: owner, keyStore: store, config: dev });
      expect(res.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a destroyed DEK is still recoverable in the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, kek);
      // A version marked destroyed in the DB, but its DEK material is still in the store.
      const v = (
        await owner.query<{ n: number }>(
          `SELECT COALESCE(MAX(key_version),0)+1 AS n FROM key_versions`,
        )
      ).rows[0]!.n;
      await store.createDek({ keyVersion: v, kekVersion: kek });
      await owner.query(
        `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version, destroyed_at)
         VALUES ($1,'destroyed',$2,$3, now())`,
        [v, `dek:v${v}`, kek],
      );
      const res = await checkLaunchGate({ pool: owner, keyStore: store, config: dev });
      expect(res.ok).toBe(false);
      expect(res.failures.join(' ')).toMatch(/still recoverable/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on a stalled destruction (window elapsed, destroyed_at null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, kek);
      const v = (
        await owner.query<{ n: number }>(
          `SELECT COALESCE(MAX(key_version),0)+1 AS n FROM key_versions`,
        )
      ).rows[0]!.n;
      await owner.query(
        `INSERT INTO key_versions
           (key_version, status, wrapped_dek_ref, kek_version, destroy_requested_at, destroy_recovery_window_until)
         VALUES ($1,'retired',$2,$3, now() - interval '10 days', now() - interval '1 day')`,
        [v, `dek:v${v}`, kek],
      );
      const res = await checkLaunchGate({ pool: owner, keyStore: store, config: dev });
      expect(res.ok).toBe(false);
      expect(res.failures.join(' ')).toMatch(/recovery window elapsed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails in production (LocalFileKeyStore is not a verified KMS — Task 8.2b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, `${KL_KEK_PREFIX}${seq}`);
      const res = await checkLaunchGate({
        pool: owner,
        keyStore: store,
        config: makeTestConfig({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'keystore' }),
      });
      expect(res.ok).toBe(false);
      expect(res.failures.join(' ')).toMatch(/verified external KMS/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes in production when the provider is railway (no destroyed drift)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, `${KL_KEK_PREFIX}${seq}`);
      const res = await checkLaunchGate({
        pool: owner,
        keyStore: store,
        config: makeTestConfig({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'railway' }),
      });
      expect(res.failures.join('\n')).not.toMatch(/requires a verified|requires the Railway/);
      expect(res.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails in production when the provider is keystore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      seq += 1;
      const { store } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, `${KL_KEK_PREFIX}${seq}`);
      const res = await checkLaunchGate({
        pool: owner,
        keyStore: store,
        config: makeTestConfig({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'keystore' }),
      });
      expect(res.ok).toBe(false);
      expect(res.failures.join('\n')).toMatch(/production requires/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
