import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileKeyStore } from '../../src/crypto/key-store.js';
import { DEK_BYTES } from '../../src/crypto/key-provider.js';

/** A hand-cranked clock so recovery-window timing is deterministic. */
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

describe('LocalFileKeyStore', () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keystore-'));
    clock = new FakeClock(Date.parse('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function store(recoveryWindowDays = 0): LocalFileKeyStore {
    return new LocalFileKeyStore({ dir, recoveryWindowDays, clock });
  }

  it('createKek then getKek round-trips the KEK bytes', async () => {
    const s = store();
    const { kekRef } = await s.createKek({ kekVersion: 'kek-1' });
    expect(kekRef).toBeTruthy();
    const kek = await s.getKek('kek-1');
    expect(kek).toHaveLength(32);
  });

  it('createDek then unwrapDek round-trips a 32-byte DEK', async () => {
    const s = store();
    await s.createKek({ kekVersion: 'kek-1' });
    const { wrappedRef } = await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    expect(wrappedRef).toBeTruthy();
    const dek = await s.unwrapDek(1);
    expect(dek).toHaveLength(DEK_BYTES);
  });

  it('produces a distinct DEK per version', async () => {
    const s = store();
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 2, kekVersion: 'kek-1' });
    const a = await s.unwrapDek(1);
    const b = await s.unwrapDek(2);
    expect(a.equals(b)).toBe(false);
  });

  it('two-state destruction (nonzero window): unwrap works + recoverable until the window elapses', async () => {
    const s = store(7);
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });

    await s.destroyDek(1);
    // Still recoverable inside the window.
    const before = await s.recoverability({ type: 'dek', keyVersion: 1 });
    expect(before.recoverable).toBe(true);
    expect(before.recoveryWindowUntil).toBeInstanceOf(Date);
    await expect(s.unwrapDek(1)).resolves.toHaveLength(DEK_BYTES);

    // Cross the window.
    clock.advanceDays(8);
    const after = await s.recoverability({ type: 'dek', keyVersion: 1 });
    expect(after.recoverable).toBe(false);
    await expect(s.unwrapDek(1)).rejects.toThrow();
  });

  it('window=0 destroys immediately', async () => {
    const s = store(0);
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await s.destroyDek(1);
    const r = await s.recoverability({ type: 'dek', keyVersion: 1 });
    expect(r.recoverable).toBe(false);
    await expect(s.unwrapDek(1)).rejects.toThrow();
  });

  it('destroyKek makes all its DEKs unrecoverable', async () => {
    const s = store(0);
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 2, kekVersion: 'kek-1' });
    // Sanity: both unwrap first.
    await expect(s.unwrapDek(1)).resolves.toHaveLength(DEK_BYTES);

    await s.destroyKek('kek-1');
    expect((await s.recoverability({ type: 'kek', kekVersion: 'kek-1' })).recoverable).toBe(false);
    await expect(s.unwrapDek(1)).rejects.toThrow();
    await expect(s.unwrapDek(2)).rejects.toThrow();
  });

  it('a non-destroyed KEK still unwraps its DEKs after another version is destroyed', async () => {
    const s = store(0);
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createKek({ kekVersion: 'kek-2' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 2, kekVersion: 'kek-2' });
    await s.destroyDek(1);
    // kek-2's DEK is untouched.
    await expect(s.unwrapDek(2)).resolves.toHaveLength(DEK_BYTES);
  });

  it('DEK wrapped files never contain the plaintext DEK, and the KEK file is 0600', async () => {
    const s = store();
    await s.createKek({ kekVersion: 'kek-1' });
    await s.createDek({ keyVersion: 1, kekVersion: 'kek-1' });
    const dek = await s.unwrapDek(1);

    // Every DEK wrapped file: none contains the plaintext DEK bytes.
    const dekDir = join(dir, 'dek');
    for (const f of readdirSync(dekDir)) {
      if (!f.endsWith('.wrapped')) continue;
      const bytes = readFileSync(join(dekDir, f));
      expect(bytes.includes(dek)).toBe(false);
    }
    // KEK file has strict owner-only perms.
    const kekFile = join(dir, 'kek', 'kek-1.key');
    expect(statSync(kekFile).mode & 0o777).toBe(0o600);
  });

  it('unwrapDek throws (never leaks key bytes) for an unknown version', async () => {
    const s = store();
    await s.createKek({ kekVersion: 'kek-1' });
    await expect(s.unwrapDek(999)).rejects.toThrow();
  });
});
