import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from '../db/_pg.js';
import { makeTestConfig } from '../_config.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { rotateKey } from '../../src/key-lifecycle/rotate.js';
import type { MaintenanceController } from '../../src/key-lifecycle/maintenance-controller.js';
import {
  KL_KEK_PREFIX,
  KL_CALL,
  cleanupKeyLifecycle,
  insertEncryptedRaw,
  insertEncryptedVaultToken,
  makeStoreProvider,
  seedIsolatedActiveKey,
} from './_helpers.js';

/** A maintenance controller whose drain never succeeds → rotation aborts (KEY_ROTATION_FAILED). */
const drainTimesOut: MaintenanceController = {
  begin: () => Promise.resolve(),
  waitForDrain: () => Promise.resolve(false),
  end: () => Promise.resolve(),
};

const FAKE_PII = 'SSN 123-45-6789 caller Jane Doe';

describe.skipIf(!hasTestDb || !hasRawTestDb)(
  'key-lifecycle privacy (no PII / key bytes on abort)',
  () => {
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

    it('a failed rotation leaks no PII or key bytes into errors or lifecycle events', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'priv-'));
      try {
        const kek = `${KL_KEK_PREFIX}priv`;
        const call = `${KL_CALL}priv`;
        const { store, provider } = makeStoreProvider(dir, owner);
        const oldVersion = await seedIsolatedActiveKey(owner, store, kek);
        await insertEncryptedRaw(owner, rawOwner, provider, call, oldVersion, FAKE_PII);
        await insertEncryptedVaultToken(
          rawOwner,
          provider,
          call,
          '[NAME_1]',
          oldVersion,
          'Jane Doe',
        );
        const dekBytes = (await store.unwrapDek(oldVersion)).toString('hex');

        let message = '';
        await expect(
          rotateKey({
            pool: owner,
            rawPool: rawOwner,
            restrictedRunner: createRestrictedRunner(rawOwner),
            keyStore: store,
            keyProvider: provider,
            maintenance: drainTimesOut,
            config: makeTestConfig({ KEY_STORE_RECOVERY_WINDOW_DAYS: 0 }),
            actor: 'kl-actor',
            approvalRef: 'JIRA-P',
          }).catch((e: unknown) => {
            message = e instanceof Error ? e.message : String(e);
            throw e;
          }),
        ).rejects.toThrow(/drain|KEY_ROTATION_FAILED/i);

        // The sanitized error carries neither PII nor key bytes.
        expect(message).not.toMatch(/123-45-6789|Jane Doe|SSN/);
        expect(message).not.toContain(dekBytes);

        // The lifecycle audit rows carry only sanitized metadata (actor + counts), never content.
        const events = await owner.query(
          `SELECT * FROM key_lifecycle_events WHERE actor = 'kl-actor'`,
        );
        const serialized = JSON.stringify(events.rows);
        expect(serialized).not.toMatch(/123-45-6789|Jane Doe|SSN/);
        expect(serialized).not.toContain(dekBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
