import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { encryptUnderVersion, decrypt } from '../../src/crypto/index.js';

/**
 * The crypto-shred invariant, in-process (no DB, no real KMS): a captured pre-destruction
 * ciphertext — the moral equivalent of a row in a backup — becomes permanently unreadable once its
 * DEK is destroyed, while a DIFFERENT version under the same (intact) KEK still decrypts. This is
 * what makes a pre-purge backup honest: the bytes survive, the key does not.
 */
describe('backup-shred invariant', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shred-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('destroying a DEK makes captured ciphertext unreadable while another version still decrypts', async () => {
    const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 2, kekVersion: 'kek-1' });

    // A version-1 provider (only needs to resolve v1 and v2 via the store).
    const provider = new KeyStoreProvider({
      keyStore: store,
      loadActiveKeyVersion: async () => 1,
    });

    const aad = Buffer.from('call-x', 'utf8');
    const captured = await encryptUnderVersion(Buffer.from('sensitive'), provider, 1, aad);
    const capturedBytes = Buffer.from(captured.ciphertext); // snapshot the "backup" bytes
    // Sanity: it decrypts before destruction.
    await expect(decrypt(captured, provider, aad)).resolves.toEqual(Buffer.from('sensitive'));

    await store.destroyDek(1);

    // The captured bytes are byte-for-byte unchanged (the backup is intact) ...
    expect(captured.ciphertext.equals(capturedBytes)).toBe(true);
    // ... but they can no longer be decrypted, and recoverability is false ...
    await expect(decrypt(captured, provider, aad)).rejects.toThrow();
    expect((await store.recoverability({ type: 'dek', keyVersion: 1 })).recoverable).toBe(false);
    // ... while version 2 (KEK intact) still works.
    await expect(provider.getDek(2)).resolves.toHaveLength(32);
  });

  it('destroying the KEK makes every DEK under it unrecoverable', async () => {
    const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 2, kekVersion: 'kek-1' });
    await store.destroyKek('kek-1');
    await expect(store.unwrapDek(1)).rejects.toThrow();
    await expect(store.unwrapDek(2)).rejects.toThrow();
  });
});
