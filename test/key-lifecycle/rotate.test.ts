import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeTestConfig } from '../_config.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { getActiveKeyVersion } from '../../src/db/repositories/key-versions-repo.js';
import { rotateKey } from '../../src/key-lifecycle/rotate.js';
import { finalizeDestruction } from '../../src/key-lifecycle/finalize-destruction.js';
import { noopMaintenance } from '../../src/key-lifecycle/maintenance-controller.js';
import {
  KL_KEK_PREFIX,
  KL_CALL,
  cleanupKeyLifecycle,
  insertEncryptedRaw,
  insertEncryptedVaultToken,
  makeStoreProvider,
  seedIsolatedActiveKey,
} from './_helpers.js';

class FakeClock {
  #ms: number;
  constructor(ms: number) {
    this.#ms = ms;
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advanceDays(d: number): void {
    this.#ms += d * 86_400_000;
  }
}

let seq = 0;

describe.skipIf(!hasTestDb)('rotateKey', () => {
  let owner!: Pool;

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

  it('re-encrypts raw+vault to the new version and crypto-shreds the old (window=0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, provider, call, oldVersion, 'raw transcript body');
      await insertEncryptedVaultToken(owner, provider, call, '[NAME_1]', oldVersion, 'Jane Doe');

      const result = await rotateKey({
        pool: owner,
        restrictedRunner: createRestrictedRunner(owner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({ KEY_STORE_RECOVERY_WINDOW_DAYS: 0 }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-1',
        now: () => new Date('2026-03-01T00:00:00Z'),
      });

      expect(result.newVersion).toBeGreaterThan(oldVersion);
      expect(result.rowsReencrypted).toBe(2);
      expect(result.finalizedInline).toBe(true);

      // Rows moved to the new version and still decrypt under it.
      const raw = await owner.query<{ key_version: number }>(
        `SELECT key_version FROM raw_transcripts WHERE call_id=$1`,
        [call],
      );
      expect(raw.rows[0]!.key_version).toBe(result.newVersion);
      await expect(store.unwrapDek(result.newVersion)).resolves.toHaveLength(32);

      // Old DEK crypto-shredded.
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(false);
      await expect(store.unwrapDek(oldVersion)).rejects.toThrow();
      const oldStatus = await owner.query<{ status: string }>(
        `SELECT status FROM key_versions WHERE key_version=$1`,
        [oldVersion],
      );
      expect(oldStatus.rows[0]!.status).toBe('destroyed');

      // Single active preserved.
      expect(await getActiveKeyVersion(owner)).toBe(result.newVersion);

      // Audit trail written.
      const events = await owner.query<{ event: string }>(
        `SELECT event FROM key_lifecycle_events WHERE actor='kl-actor'`,
      );
      const kinds = events.rows.map((r) => r.event);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'rotate_started',
          'rotate_completed',
          'destroy_requested',
          'destroy_confirmed',
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tombstone (empty ciphertext) at the old version does not block rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      // A hard-deleted tombstone: keeps old key_version, empty ciphertext.
      await owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1,'test','store','completed') ON CONFLICT (call_id) DO NOTHING`,
        [call],
      );
      await owner.query(
        `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, hard_deleted_at)
         VALUES ($1, ''::bytea, $2, now())`,
        [call, oldVersion],
      );

      const result = await rotateKey({
        pool: owner,
        restrictedRunner: createRestrictedRunner(owner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({ KEY_STORE_RECOVERY_WINDOW_DAYS: 0 }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-2',
        now: () => new Date('2026-03-01T00:00:00Z'),
      });
      // Nothing recoverable to move; rotation still completes and shreds the old key.
      expect(result.rowsReencrypted).toBe(0);
      expect(result.finalizedInline).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nonzero window: Phase A does not destroy; finalizer destroys after the window elapses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const clock = new FakeClock(Date.parse('2026-03-01T00:00:00Z'));
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 7, clock });
      const provider = new KeyStoreProvider({
        keyStore: store,
        loadActiveKeyVersion: () => getActiveKeyVersion(owner),
        activeVersionTtlMs: 0,
      });
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, provider, call, oldVersion, 'body');

      const result = await rotateKey({
        pool: owner,
        restrictedRunner: createRestrictedRunner(owner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({ KEY_STORE_RECOVERY_WINDOW_DAYS: 7 }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-3',
        now: () => clock.now(),
      });
      expect(result.finalizedInline).toBe(false);

      // Inside the window: still recoverable, not yet destroyed.
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(true);
      let status = await owner.query<{ status: string }>(
        `SELECT status FROM key_versions WHERE key_version=$1`,
        [oldVersion],
      );
      expect(status.rows[0]!.status).toBe('retired');

      // A premature finalize is a no-op (still pending).
      const early = await finalizeDestruction({
        pool: owner,
        keyStore: store,
        actor: 'kl-actor',
      });
      expect(early.finalizedDeks).toHaveLength(0);
      expect(early.pendingDeks).toContain(oldVersion);

      // Cross the window, then finalize.
      clock.advanceDays(8);
      const done = await finalizeDestruction({
        pool: owner,
        keyStore: store,
        actor: 'kl-actor',
      });
      expect(done.finalizedDeks).toContain(oldVersion);
      status = await owner.query<{ status: string }>(
        `SELECT status FROM key_versions WHERE key_version=$1`,
        [oldVersion],
      );
      expect(status.rows[0]!.status).toBe('destroyed');
      await expect(store.unwrapDek(oldVersion)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
