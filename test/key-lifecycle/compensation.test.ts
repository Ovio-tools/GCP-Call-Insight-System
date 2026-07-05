import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Queryable } from '../../src/db/types.js';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { bootstrapKey } from '../../src/key-lifecycle/bootstrap.js';
import { rotateKek } from '../../src/key-lifecycle/rotate-kek.js';

/**
 * Bootstrap and KEK rotation create external key material (KEK, wrapped DEK) BEFORE writing durable
 * metadata. If the metadata write fails, the just-created external material must be destroyed —
 * otherwise it is stranded with no DB lifecycle record. A window-0 store purges immediately, so
 * "compensated" == "no longer recoverable".
 */
describe('key-lifecycle store compensation on DB-write failure', () => {
  /** A fake DB that answers the pre-write SELECT/UPDATE reads but rejects the first INSERT. */
  function failingDb(reads: (sql: string) => unknown[]): Queryable {
    return {
      query: (text: string) => {
        if (/^\s*INSERT/i.test(text)) return Promise.reject(new Error('db insert failed'));
        return Promise.resolve({ rows: reads(text) });
      },
    } as unknown as Queryable;
  }

  it('bootstrapKey destroys the created KEK + DEK when the metadata insert fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'komp-'));
    try {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      const db = failingDb(() => [{ n: 0 }]); // no active KEK/DEK yet

      await expect(
        bootstrapKey({
          db,
          keyStore: store,
          kekVersion: 'komp-kek-1',
          actor: 'komp-actor',
          approvalRef: 'JIRA-komp',
          keyVersion: 7,
        }),
      ).rejects.toThrow('db insert failed');

      expect(
        (await store.recoverability({ type: 'kek', kekVersion: 'komp-kek-1' })).recoverable,
      ).toBe(false);
      expect((await store.recoverability({ type: 'dek', keyVersion: 7 })).recoverable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotateKek destroys the newly created KEK when the metadata insert fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'komp-'));
    try {
      const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
      // getActiveKek → old KEK; updateKekStatus RETURNING → 1 row; INSERT → throws.
      const db = failingDb(() => [{ kek_version: 'komp-old' }]);

      await expect(
        rotateKek({
          db,
          keyStore: store,
          newKekVersion: 'komp-new',
          actor: 'komp-actor',
          approvalRef: 'JIRA-komp',
        }),
      ).rejects.toThrow('db insert failed');

      expect(
        (await store.recoverability({ type: 'kek', kekVersion: 'komp-new' })).recoverable,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
