import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from '../db/_pg.js';
import { makeTestConfig } from '../_config.js';
import { decrypt } from '../../src/crypto/index.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import {
  getActiveKeyVersion,
  markDestroyRequested,
} from '../../src/db/repositories/key-versions-repo.js';
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

// Flag-gated stub of the DB-B re-encryption. Default OFF, so every other test uses the REAL
// re-encryption; the residual-gate test flips it ON to make `reencryptRawTranscripts` a no-op,
// leaving a seeded old-version row on DB-B so the real `countRecoverableAtVersion` verify gate
// (which reads DB-B) fires KEY_ROTATION_FAILED before any destroy.
const reencryptStub = vi.hoisted(() => ({ skipRaw: false }));
vi.mock('../../src/key-lifecycle/reencrypt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/key-lifecycle/reencrypt.js')>();
  return {
    ...actual,
    reencryptRawTranscripts: (
      pool: Parameters<typeof actual.reencryptRawTranscripts>[0],
      opts: Parameters<typeof actual.reencryptRawTranscripts>[1],
    ) => (reencryptStub.skipRaw ? Promise.resolve(0) : actual.reencryptRawTranscripts(pool, opts)),
  };
});

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
  advanceMs(ms: number): void {
    this.#ms += ms;
  }
}

let seq = 0;

describe.skipIf(!hasTestDb || !hasRawTestDb)('rotateKey', () => {
  let owner!: Pool;
  let rawOwner!: Pool;

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

  it('re-encrypts raw+vault to the new version and crypto-shreds the old (window=0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, 'raw transcript body');
      await insertEncryptedVaultToken(rawOwner, provider, call, '[NAME_1]', oldVersion, 'Jane Doe');

      const result = await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
        }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-1',
        now: () => new Date('2026-03-01T00:00:00Z'),
      });

      expect(result.newVersion).toBeGreaterThan(oldVersion);
      expect(result.rowsReencrypted).toBe(2);
      expect(result.finalizedInline).toBe(true);

      // Raw rows moved to the new version and still decrypt under it (all on DB-B).
      const raw = await rawOwner.query<{ key_version: number }>(
        `SELECT key_version FROM raw_transcripts WHERE call_id=$1`,
        [call],
      );
      expect(raw.rows[0]!.key_version).toBe(result.newVersion);
      await expect(store.unwrapDek(result.newVersion)).resolves.toHaveLength(32);

      // Vault re-encryption is explicit: the token bumped to the new version on DB-B and still
      // decrypts to its plaintext under it (guards against silently skipping vault re-encryption).
      const vault = await rawOwner.query<{ key_version: number; ciphertext: Buffer }>(
        `SELECT key_version, ciphertext FROM token_vault WHERE call_id=$1 AND token=$2`,
        [call, '[NAME_1]'],
      );
      expect(vault.rows[0]!.key_version).toBe(result.newVersion);
      const decryptedToken = await decrypt(
        { ciphertext: vault.rows[0]!.ciphertext, keyVersion: result.newVersion },
        provider,
        Buffer.from(call, 'utf8'),
      );
      expect(decryptedToken.toString('utf8')).toBe('Jane Doe');

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

  it('the verify gate rejects a residual DB-B row at the old version and does NOT destroy the old key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      // Make raw re-encryption a no-op so a recoverable old-version row survives on DB-B.
      reencryptStub.skipRaw = true;
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      // A recoverable raw row at the OLD version that the stubbed re-encryption WON'T move.
      await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, 'unswept body');
      const destroySpy = vi.spyOn(store, 'destroyDek');

      await expect(
        rotateKey({
          pool: owner,
          rawPool: rawOwner,
          restrictedRunner: createRestrictedRunner(rawOwner),
          keyStore: store,
          keyProvider: provider,
          maintenance: noopMaintenance,
          config: makeTestConfig({
            KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
            KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
          }),
          actor: 'kl-actor',
          approvalRef: 'JIRA-residual',
          now: () => new Date('2026-03-01T00:00:00Z'),
        }),
      ).rejects.toThrow(/recoverable rows still at key_version|KEY_ROTATION_FAILED/i);

      // The verify gate fired BEFORE any destruction: no destroyDek, no destroy-request, and the
      // old version is still active + recoverable in the store (crypto-shred was NOT performed).
      expect(destroySpy).not.toHaveBeenCalled();
      const row = await owner.query<{ status: string; destroy_requested_at: Date | null }>(
        `SELECT status, destroy_requested_at FROM key_versions WHERE key_version=$1`,
        [oldVersion],
      );
      expect(row.rows[0]!.status).toBe('active');
      expect(row.rows[0]!.destroy_requested_at).toBeNull();
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(true);
    } finally {
      reencryptStub.skipRaw = false;
      vi.restoreAllMocks();
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
      await rawOwner.query(
        `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, hard_deleted_at)
         VALUES ($1, ''::bytea, $2, now())`,
        [call, oldVersion],
      );

      const result = await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
        }),
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

  it('keeps the OLD version active during the sweep — the swap is deferred until after re-encryption (crash-after-swap safety)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, 'body');

      // The drain runs after the pause but before the sweep. Capturing the active version here
      // proves the swap has NOT yet happened: if it had, a crash now would strand the old rows
      // (retired + un-swept) and re-running would rotate the NEW key instead of finishing the old.
      let activeAtDrain: number | undefined;
      const spy = {
        ...noopMaintenance,
        waitForDrain: async (): Promise<boolean> => {
          activeAtDrain = await getActiveKeyVersion(owner);
          return true;
        },
      };

      const result = await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: provider,
        maintenance: spy,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
        }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-drain',
        now: () => new Date('2026-03-01T00:00:00Z'),
      });

      expect(activeAtDrain).toBe(oldVersion);
      expect(result.newVersion).toBeGreaterThan(oldVersion);
      // And the sweep still completed: new version active, old crypto-shredded.
      expect(await getActiveKeyVersion(owner)).toBe(result.newVersion);
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes the queue only AFTER the old key destruction is requested (no stale-cache write window)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const { store, provider } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, 'body');

      // `end()` resumes the queue. At that instant the old key's destruction MUST already be
      // requested; otherwise a worker resuming with a stale active-version cache could write fresh
      // ciphertext under the about-to-be-shredded key.
      let destroyRequestedAtResume: number | undefined;
      const spy = {
        ...noopMaintenance,
        end: async (): Promise<void> => {
          destroyRequestedAtResume = (
            await owner.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM key_versions WHERE destroy_requested_at IS NOT NULL`,
            )
          ).rows[0]!.n;
        },
      };

      await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: provider,
        maintenance: spy,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 0,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
        }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-resume',
        now: () => new Date('2026-03-01T00:00:00Z'),
      });

      expect(destroyRequestedAtResume).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confirm-destruction completes a rotation that crashed AFTER the DB commit but BEFORE destroyDek', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const { store } = makeStoreProvider(dir, owner);
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);

      // Simulate the crash gap: the DB has committed the swap + destroy-request, but the store
      // never received destroyDek — the old material is still ACTIVE/recoverable. Without a
      // re-issue, the finalizer's recoverability check would report it pending forever.
      await owner.query(`UPDATE key_versions SET status='retired' WHERE key_version=$1`, [
        oldVersion,
      ]);
      await markDestroyRequested(owner, oldVersion, {
        recoveryWindowUntil: new Date('2026-03-01T00:00:00Z'),
        approvalRef: 'JIRA-crash',
      });
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(true);

      const done = await finalizeDestruction({ pool: owner, keyStore: store, actor: 'kl-actor' });

      expect(done.finalizedDeks).toContain(oldVersion);
      expect(
        (await store.recoverability({ type: 'dek', keyVersion: oldVersion })).recoverable,
      ).toBe(false);
      const st = await owner.query<{ status: string }>(
        `SELECT status FROM key_versions WHERE key_version=$1`,
        [oldVersion],
      );
      expect(st.rows[0]!.status).toBe('destroyed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nonzero window: a worker with a stale active-version cache cannot write under the old version after resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rot-'));
    try {
      seq += 1;
      const kek = `${KL_KEK_PREFIX}${seq}`;
      const call = `${KL_CALL}${seq}`;
      const clock = new FakeClock(Date.parse('2026-03-01T00:00:00Z'));
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 7, clock });
      const rotationProvider = new KeyStoreProvider({
        keyStore: store,
        loadActiveKeyVersion: () => getActiveKeyVersion(owner),
        activeVersionTtlMs: 0,
      });
      const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
      await insertEncryptedRaw(owner, rawOwner, rotationProvider, call, oldVersion, 'body');

      // A separate "worker" provider that caches the active version with a 5s TTL on the same clock.
      const workerProvider = new KeyStoreProvider({
        keyStore: store,
        loadActiveKeyVersion: () => getActiveKeyVersion(owner),
        clock,
        activeVersionTtlMs: 5_000,
      });
      // Prime its cache while the OLD version is still active.
      expect(await workerProvider.currentKeyVersion()).toBe(oldVersion);

      await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: rotationProvider,
        maintenance: noopMaintenance,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 7,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 5_000,
        }),
        actor: 'kl-actor',
        approvalRef: 'JIRA-stale',
        now: () => clock.now(),
        // The settle-wait must let real time pass; advancing the shared clock expires the cache.
        sleep: (ms: number) => {
          clock.advanceMs(ms);
          return Promise.resolve();
        },
      });

      const newVersion = await getActiveKeyVersion(owner);
      expect(newVersion).toBeGreaterThan(oldVersion);
      // After the settle-wait + resume, the stale worker cache has expired → it sees the NEW version
      // and can never write under the old, about-to-be-shredded one.
      expect(await workerProvider.currentKeyVersion()).toBe(newVersion);
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
      await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, 'body');

      const result = await rotateKey({
        pool: owner,
        rawPool: rawOwner,
        restrictedRunner: createRestrictedRunner(rawOwner),
        keyStore: store,
        keyProvider: provider,
        maintenance: noopMaintenance,
        config: makeTestConfig({
          KEY_STORE_RECOVERY_WINDOW_DAYS: 7,
          KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: 0,
        }),
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
