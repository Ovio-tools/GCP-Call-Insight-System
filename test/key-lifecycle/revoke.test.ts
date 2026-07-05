import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeTestConfig } from '../_config.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { getActiveKeyVersion } from '../../src/db/repositories/key-versions-repo.js';
import { revokeDek, revokeKek } from '../../src/key-lifecycle/revoke.js';
import {
  KL_KEK_PREFIX,
  KL_CALL,
  cleanupKeyLifecycle,
  insertEncryptedRaw,
  makeStoreProvider,
  seedIsolatedActiveKey,
} from './_helpers.js';
import type { LocalFileKeyStore } from '../../src/crypto/key-store.js';

let seq = 0;

async function seedRetiredKey(
  owner: Pool,
  store: LocalFileKeyStore,
  kek: string,
): Promise<number> {
  const v = (
    await owner.query<{ n: number }>(`SELECT COALESCE(MAX(key_version),0)+1 AS n FROM key_versions`)
  ).rows[0]!.n;
  await store.createDek({ keyVersion: v, kekVersion: kek });
  await owner.query(
    `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
     VALUES ($1,'retired',$2,$3)`,
    [v, `dek:v${v}`, kek],
  );
  return v;
}

describe.skipIf(!hasTestDb)('revoke', () => {
  let owner!: Pool;
  const enabled = makeTestConfig({
    KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
    CRYPTO_KEY_DESTROY_COMMANDS_ENABLED: true,
  });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
  });
  beforeEach(async () => {
    await cleanupKeyLifecycle(owner);
  });
  afterEach(async () => {
    await cleanupKeyLifecycle(owner);
  });

  it('revokeDek crypto-shreds one retired version and records the blast radius', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      await seedIsolatedActiveKey(owner, store, kek);
      const target = await seedRetiredKey(owner, store, kek);
      await insertEncryptedRaw(owner, provider, call, target, 'secret body');

      const result = await revokeDek(
        {
          pool: owner,
          restrictedRunner: createRestrictedRunner(owner),
          keyStore: store,
          config: enabled,
          actor: 'kl-actor',
          approvalRef: 'JIRA-9',
          confirmationMatched: true,
          now: () => new Date('2026-04-01T00:00:00Z'),
        },
        target,
      );
      expect(result.affectedRaw).toBe(1);
      expect(result.finalizedInline).toBe(true);

      // Destroyed + unreadable.
      const status = await owner.query<{ status: string }>(
        `SELECT status FROM key_versions WHERE key_version=$1`,
        [target],
      );
      expect(status.rows[0]!.status).toBe('destroyed');
      await expect(store.unwrapDek(target)).rejects.toThrow();

      // Audit records the confirmation + counts, never the phrase.
      const ev = await owner.query<{ confirmation_matched: boolean; affected_raw_count: number }>(
        `SELECT confirmation_matched, affected_raw_count FROM key_lifecycle_events
          WHERE event='revoke_dek' AND key_version=$1`,
        [target],
      );
      expect(ev.rows[0]!.confirmation_matched).toBe(true);
      expect(ev.rows[0]!.affected_raw_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('revokeDek refuses the active version and refuses when destroy commands are disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const { store } = makeStoreProvider(dir, owner);
      const active = await seedIsolatedActiveKey(owner, store, kek);

      await expect(
        revokeDek(
          {
            pool: owner,
            restrictedRunner: createRestrictedRunner(owner),
            keyStore: store,
            config: enabled,
            actor: 'kl-actor',
            approvalRef: 'x',
          },
          active,
        ),
      ).rejects.toThrow(/active/i);

      const target = await seedRetiredKey(owner, store, kek);
      await expect(
        revokeDek(
          {
            pool: owner,
            restrictedRunner: createRestrictedRunner(owner),
            keyStore: store,
            config: makeTestConfig({ CRYPTO_KEY_DESTROY_COMMANDS_ENABLED: false }),
            actor: 'kl-actor',
            approvalRef: 'x',
          },
          target,
        ),
      ).rejects.toThrow(/disabled/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('revokeKek shreds every version under a KEK and leaves the active KEK untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-'));
    try {
      seq += 1;
      const kekActive = `${KL_KEK_PREFIX}${seq}-a`;
      const kekTarget = `${KL_KEK_PREFIX}${seq}-b`;
      const call1 = `${KL_CALL}${seq}-1`;
      const call2 = `${KL_CALL}${seq}-2`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const active = await seedIsolatedActiveKey(owner, store, kekActive);
      // A separate KEK with two retired DEKs + rows.
      await store.createKek({ kekVersion: kekTarget });
      await owner.query(
        `INSERT INTO kek_versions (kek_version, status, external_kek_ref) VALUES ($1,'retired',$2)`,
        [kekTarget, `kek:${kekTarget}`],
      );
      const vB1 = await seedRetiredKey(owner, store, kekTarget);
      const vB2 = await seedRetiredKey(owner, store, kekTarget);
      await insertEncryptedRaw(owner, provider, call1, vB1, 'body1');
      await insertEncryptedRaw(owner, provider, call2, vB2, 'body2');

      const result = await revokeKek(
        {
          pool: owner,
          restrictedRunner: createRestrictedRunner(owner),
          keyStore: store,
          config: enabled,
          actor: 'kl-actor',
          approvalRef: 'JIRA-KEK',
          confirmationMatched: true,
        },
        kekTarget,
      );
      expect(result.affectedRaw).toBe(2);
      expect(result.affectedVersions.sort()).toEqual([vB1, vB2].sort());

      // Both versions destroyed + unreadable; the KEK destroyed.
      for (const v of [vB1, vB2]) {
        await expect(store.unwrapDek(v)).rejects.toThrow();
      }
      const kekStatus = await owner.query<{ status: string }>(
        `SELECT status FROM kek_versions WHERE kek_version=$1`,
        [kekTarget],
      );
      expect(kekStatus.rows[0]!.status).toBe('destroyed');

      // The active key + its KEK are untouched.
      expect(await getActiveKeyVersion(owner)).toBe(active);
      await expect(store.unwrapDek(active)).resolves.toHaveLength(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
