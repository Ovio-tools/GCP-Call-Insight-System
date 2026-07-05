import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { KeyStoreProvider } from '../../src/crypto/key-store-provider.js';
import { DEK_BYTES } from '../../src/crypto/key-provider.js';

class FakeClock {
  #ms: number;
  constructor(startMs: number) {
    this.#ms = startMs;
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advanceMs(ms: number): void {
    this.#ms += ms;
  }
}

describe('KeyStoreProvider', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ksp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('getDek unwraps the DEK via the key store', async () => {
    const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    const provider = new KeyStoreProvider({ keyStore: store, loadActiveKeyVersion: async () => 1 });
    expect(await provider.getDek(1)).toHaveLength(DEK_BYTES);
  });

  it('currentKeyVersion is DB-sourced and caches within the short TTL', async () => {
    const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
    const clock = new FakeClock(1000);
    let calls = 0;
    let active = 3;
    const provider = new KeyStoreProvider({
      keyStore: store,
      loadActiveKeyVersion: async () => {
        calls += 1;
        return active;
      },
      clock,
      activeVersionTtlMs: 5000,
    });

    expect(await provider.currentKeyVersion()).toBe(3);
    expect(await provider.currentKeyVersion()).toBe(3);
    expect(calls).toBe(1); // cached within TTL

    // Active flips in the DB, but the cache masks it until the TTL passes.
    active = 4;
    clock.advanceMs(4000);
    expect(await provider.currentKeyVersion()).toBe(3);
    clock.advanceMs(2000); // now past the 5s TTL
    expect(await provider.currentKeyVersion()).toBe(4);
    expect(calls).toBe(2);
  });

  it('invalidateActiveVersion forces a re-read (rotation hook)', async () => {
    const store = new LocalFileKeyStore({ dir, recoveryWindowDays: 0 });
    let active = 1;
    let calls = 0;
    const provider = new KeyStoreProvider({
      keyStore: store,
      loadActiveKeyVersion: async () => {
        calls += 1;
        return active;
      },
    });
    expect(await provider.currentKeyVersion()).toBe(1);
    active = 2;
    provider.invalidateActiveVersion();
    expect(await provider.currentKeyVersion()).toBe(2);
    expect(calls).toBe(2);
  });
});
