import { beforeEach, describe, expect, it } from 'vitest';
import { EnvSecretBackend, InMemorySecretBackend } from '../../src/crypto/secret-backend.js';
import { RailwaySecretKeyStore } from '../../src/crypto/railway-secret-key-store.js';
import { DEK_BYTES } from '../../src/crypto/key-provider.js';

const KEK_SECRET = 'CRYPTO_KEK_MATERIAL';
const DEK_SECRET = 'CRYPTO_WRAPPED_DEK_MATERIAL';

class FakeClock {
  #ms: number;
  constructor(startMs: number) {
    this.#ms = startMs;
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advanceDays(days: number): void {
    this.#ms += days * 24 * 60 * 60 * 1000;
  }
}

function makeStore(backend: InMemorySecretBackend, clock: FakeClock, recoveryWindowDays = 7) {
  return new RailwaySecretKeyStore({
    backend,
    kekSecretName: KEK_SECRET,
    dekSecretName: DEK_SECRET,
    recoveryWindowDays,
    clock,
  });
}

describe('RailwaySecretKeyStore — KEK', () => {
  let backend: InMemorySecretBackend;
  let clock: FakeClock;
  let store: RailwaySecretKeyStore;
  beforeEach(() => {
    backend = new InMemorySecretBackend();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = makeStore(backend, clock);
  });

  it('creates a KEK, returns a ref, and hands back its bytes', async () => {
    const { kekRef } = await store.createKek({ kekVersion: 'kek-1' });
    expect(kekRef).toBe('kek:kek-1');
    expect(await store.getKek('kek-1')).toHaveLength(32);
  });
  it('mints distinct random bytes per KEK version', async () => {
    await store.createKek({ kekVersion: 'kek-1' });
    const a = await store.getKek('kek-1');
    await store.createKek({ kekVersion: 'kek-2' });
    const b = await store.getKek('kek-2');
    expect(a.equals(b)).toBe(false);
  });
  it('refuses to create a KEK version twice', async () => {
    await store.createKek({ kekVersion: 'kek-1' });
    await expect(store.createKek({ kekVersion: 'kek-1' })).rejects.toThrow(/already exists/);
  });
  it('getKek throws for an unknown version', async () => {
    await expect(store.getKek('nope')).rejects.toThrow(/not found/);
  });
  it('destroyKek keeps bytes readable during the recovery window, then unreadable after', async () => {
    await store.createKek({ kekVersion: 'kek-1' });
    await store.destroyKek('kek-1');
    clock.advanceDays(3);
    expect(await store.getKek('kek-1')).toHaveLength(32);
    clock.advanceDays(5);
    await expect(store.getKek('kek-1')).rejects.toThrow(/destroyed/);
  });
  it('a zero-day window destroys immediately', async () => {
    const immediate = makeStore(backend, clock, 0);
    await immediate.createKek({ kekVersion: 'kek-1' });
    await immediate.destroyKek('kek-1');
    // destroyKek physically purges the bytes at a zero-day window, so the entry is gone entirely
    // (not merely marked destroyed) — matching LocalFileKeyStore.
    await expect(immediate.getKek('kek-1')).rejects.toThrow(/not found/);
  });
});

describe('RailwaySecretKeyStore — DEK', () => {
  let backend: InMemorySecretBackend;
  let clock: FakeClock;
  let store: RailwaySecretKeyStore;
  beforeEach(async () => {
    backend = new InMemorySecretBackend();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = makeStore(backend, clock);
    await store.createKek({ kekVersion: 'kek-1' });
  });

  it('creates and unwraps a DEK of the right length', async () => {
    const { wrappedRef } = await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    expect(wrappedRef).toBe('dek:v1');
    expect(await store.unwrapDek(1)).toHaveLength(DEK_BYTES);
  });
  it('unwrap round-trips the same DEK bytes across calls', async () => {
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    const a = await store.unwrapDek(1);
    const b = await store.unwrapDek(1);
    expect(a.equals(b)).toBe(true);
  });
  it('refuses to create a DEK version twice', async () => {
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await expect(store.createDek({ keyVersion: 1, kekVersion: 'kek-1' })).rejects.toThrow(
      /already exists/,
    );
  });
  it('rejects a non-positive key version', async () => {
    await expect(store.createDek({ keyVersion: 0, kekVersion: 'kek-1' })).rejects.toThrow(
      /positive integer/,
    );
  });
  it('unwrap fails once the wrapping KEK is destroyed past its window (crypto-shred)', async () => {
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.destroyKek('kek-1');
    clock.advanceDays(8);
    await expect(store.unwrapDek(1)).rejects.toThrow(/destroyed/);
  });
  it('destroyDek keeps it recoverable during the window, then not after', async () => {
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.destroyDek(1);
    clock.advanceDays(3);
    expect(await store.unwrapDek(1)).toHaveLength(DEK_BYTES);
    clock.advanceDays(5);
    await expect(store.unwrapDek(1)).rejects.toThrow(/not recoverable/);
  });
});

describe('RailwaySecretKeyStore — recoverability', () => {
  let backend: InMemorySecretBackend;
  let clock: FakeClock;
  let store: RailwaySecretKeyStore;
  beforeEach(async () => {
    backend = new InMemorySecretBackend();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = makeStore(backend, clock);
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
  });

  it('reports a live KEK and DEK as recoverable with no window', async () => {
    expect(await store.recoverability({ type: 'kek', kekVersion: 'kek-1' })).toEqual({
      recoverable: true,
      recoveryWindowUntil: null,
    });
    expect(await store.recoverability({ type: 'dek', keyVersion: 1 })).toEqual({
      recoverable: true,
      recoveryWindowUntil: null,
    });
  });
  it('an unknown version is not recoverable', async () => {
    expect(await store.recoverability({ type: 'kek', kekVersion: 'nope' })).toEqual({
      recoverable: false,
      recoveryWindowUntil: null,
    });
    expect(await store.recoverability({ type: 'dek', keyVersion: 99 })).toEqual({
      recoverable: false,
      recoveryWindowUntil: null,
    });
  });
  it('a pending KEK is recoverable until the window elapses', async () => {
    await store.destroyKek('kek-1');
    const during = await store.recoverability({ type: 'kek', kekVersion: 'kek-1' });
    expect(during.recoverable).toBe(true);
    expect(during.recoveryWindowUntil).toBeInstanceOf(Date);
    clock.advanceDays(8);
    expect(await store.recoverability({ type: 'kek', kekVersion: 'kek-1' })).toEqual({
      recoverable: false,
      recoveryWindowUntil: null,
    });
  });
  it('a DEK is unrecoverable once its KEK is destroyed, even if the DEK entry survives', async () => {
    await store.destroyKek('kek-1');
    clock.advanceDays(8);
    expect(await store.recoverability({ type: 'dek', keyVersion: 1 })).toEqual({
      recoverable: false,
      recoveryWindowUntil: null,
    });
  });
});

describe('RailwaySecretKeyStore — physical crypto-shred', () => {
  let backend: InMemorySecretBackend;
  let clock: FakeClock;
  beforeEach(() => {
    backend = new InMemorySecretBackend();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
  });

  it('a zero-day destroyKek leaves NO raw KEK bytes in the secret document', async () => {
    const store = makeStore(backend, clock, 0);
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.destroyKek('kek-1');
    const raw = await backend.read(KEK_SECRET);
    expect(raw).toBeDefined();
    const doc = JSON.parse(raw!) as {
      active: Record<string, unknown>;
      pending: Record<string, unknown>;
    };
    expect(doc.active['kek-1']).toBeUndefined();
    expect(doc.pending['kek-1']).toBeUndefined();
  });

  it('a zero-day destroyDek leaves NO wrapped-DEK bytes in the secret document', async () => {
    const store = makeStore(backend, clock, 0);
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.destroyDek(1);
    const raw = await backend.read(DEK_SECRET);
    expect(raw).toBeDefined();
    const doc = JSON.parse(raw!) as {
      active: Record<string, unknown>;
      pending: Record<string, unknown>;
    };
    expect(doc.active[1]).toBeUndefined();
    expect(doc.pending[1]).toBeUndefined();
  });

  it('the finalizer path (destroyKek + recoverability, no getKek) leaves no bytes after the window', async () => {
    const store = makeStore(backend, clock, 7);
    await store.createKek({ kekVersion: 'kek-1' });
    await store.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await store.destroyKek('kek-1');
    await store.destroyDek(1);
    clock.advanceDays(8);
    // Mirror the finalizer: it re-issues destroy then reads recoverability; it NEVER calls getKek.
    await store.destroyKek('kek-1');
    await store.destroyDek(1);
    expect((await store.recoverability({ type: 'kek', kekVersion: 'kek-1' })).recoverable).toBe(
      false,
    );
    expect((await store.recoverability({ type: 'dek', keyVersion: 1 })).recoverable).toBe(false);

    const kekDoc = JSON.parse((await backend.read(KEK_SECRET))!) as {
      active: Record<string, unknown>;
      pending: Record<string, unknown>;
    };
    const dekDoc = JSON.parse((await backend.read(DEK_SECRET))!) as {
      active: Record<string, unknown>;
      pending: Record<string, unknown>;
    };
    expect(kekDoc.active['kek-1']).toBeUndefined();
    expect(kekDoc.pending['kek-1']).toBeUndefined();
    expect(dekDoc.active[1]).toBeUndefined();
    expect(dekDoc.pending[1]).toBeUndefined();
  });
});

describe('RailwaySecretKeyStore — read-only backend', () => {
  let seed: InMemorySecretBackend;
  let clock: FakeClock;
  beforeEach(async () => {
    seed = new InMemorySecretBackend();
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    const writable = makeStore(seed, clock, 7);
    await writable.createKek({ kekVersion: 'kek-1' });
    await writable.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
  });

  it('serves reads (getKek / unwrapDek) over a read-only EnvSecretBackend', async () => {
    // Materialize the seeded docs into plain strings for the env backend.
    const kekRaw = (await seed.read(KEK_SECRET))!;
    const dekRaw = (await seed.read(DEK_SECRET))!;
    const env = new EnvSecretBackend({ [KEK_SECRET]: kekRaw, [DEK_SECRET]: dekRaw });
    const store = new RailwaySecretKeyStore({
      backend: env,
      kekSecretName: KEK_SECRET,
      dekSecretName: DEK_SECRET,
      recoveryWindowDays: 7,
      clock,
    });
    expect(await store.getKek('kek-1')).toHaveLength(32);
    expect(await store.unwrapDek(1)).toHaveLength(DEK_BYTES);
  });

  it('reading an elapsed-pending entry over a read-only backend does not surface ReadOnlySecretBackendError', async () => {
    // Seed a store whose material is already pending-destroyed, then freeze that doc into env.
    const writable = makeStore(seed, clock, 7);
    await writable.destroyKek('kek-1');
    await writable.destroyDek(1);
    const kekRaw = (await seed.read(KEK_SECRET))!;
    const dekRaw = (await seed.read(DEK_SECRET))!;
    const env = new EnvSecretBackend({ [KEK_SECRET]: kekRaw, [DEK_SECRET]: dekRaw });
    const store = new RailwaySecretKeyStore({
      backend: env,
      kekSecretName: KEK_SECRET,
      dekSecretName: DEK_SECRET,
      recoveryWindowDays: 7,
      clock,
    });
    clock.advanceDays(8);
    // getKek hits the lazy-purge branch; #tryWrite must swallow the read-only write attempt so the
    // caller sees the normal /destroyed/ error, never a ReadOnlySecretBackendError.
    await expect(store.getKek('kek-1')).rejects.toThrow(/destroyed/);
    // recoverability also attempts a best-effort purge write; it must degrade gracefully.
    expect((await store.recoverability({ type: 'kek', kekVersion: 'kek-1' })).recoverable).toBe(
      false,
    );
    expect((await store.recoverability({ type: 'dek', keyVersion: 1 })).recoverable).toBe(false);
  });
});
