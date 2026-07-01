import { describe, expect, it } from 'vitest';
import { DEK_BYTES, LocalKeyProvider, decrypt, encrypt } from '../../src/crypto/index.js';

/** Deterministic test provider; two versions active for the version-mismatch case. */
function provider(activeKeyVersion = 1): LocalKeyProvider {
  return new LocalKeyProvider({ masterKey: Buffer.alloc(DEK_BYTES, 0x2a), activeKeyVersion });
}

describe('envelope encryption', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const kp = provider();
    const plaintext = Buffer.from('customer said: my sink is leaking', 'utf8');
    const enc = await encrypt(plaintext, kp);
    expect(enc.keyVersion).toBe(1);
    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
    // Ciphertext is not the plaintext, and carries iv(12)+tag(16) overhead.
    expect(enc.ciphertext.equals(plaintext)).toBe(false);
    expect(enc.ciphertext.length).toBe(plaintext.length + 12 + 16);

    const back = await decrypt(enc, kp);
    expect(back.equals(plaintext)).toBe(true);
  });

  it('round-trips with additional authenticated data (aad)', async () => {
    const kp = provider();
    const aad = Buffer.from('call-123', 'utf8');
    const enc = await encrypt(Buffer.from('secret'), kp, aad);
    const back = await decrypt(enc, kp, aad);
    expect(back.toString('utf8')).toBe('secret');
  });

  it('fails to decrypt when the aad differs', async () => {
    const kp = provider();
    const enc = await encrypt(Buffer.from('secret'), kp, Buffer.from('call-a'));
    await expect(decrypt(enc, kp, Buffer.from('call-b'))).rejects.toThrow();
  });

  it('fails to decrypt under the wrong key_version', async () => {
    const kp = provider();
    const enc = await encrypt(Buffer.from('secret'), kp);
    // Same provider, but claim a different version → different DEK → GCM tag fails.
    await expect(decrypt({ ciphertext: enc.ciphertext, keyVersion: 2 }, kp)).rejects.toThrow();
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const kp = provider();
    const enc = await encrypt(Buffer.from('secret'), kp);
    const tampered = Buffer.from(enc.ciphertext);
    // Flip a byte in the ciphertext body so the GCM auth tag no longer verifies.
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(
      decrypt({ ciphertext: tampered, keyVersion: enc.keyVersion }, kp),
    ).rejects.toThrow();
  });

  it('rejects a ciphertext too short to hold iv + tag', async () => {
    const kp = provider();
    await expect(decrypt({ ciphertext: Buffer.alloc(4), keyVersion: 1 }, kp)).rejects.toThrow(
      /too short/,
    );
  });
});

describe('LocalKeyProvider', () => {
  it('derives a 32-byte DEK', async () => {
    const dek = await provider().getDek(1);
    expect(dek.length).toBe(DEK_BYTES);
  });

  it('derives distinct DEKs per key_version', async () => {
    const kp = provider();
    const v1 = await kp.getDek(1);
    const v2 = await kp.getDek(2);
    expect(v1.equals(v2)).toBe(false);
  });

  it('reports the active key_version', async () => {
    expect(await provider(3).currentKeyVersion()).toBe(3);
  });

  it('rejects a too-short master key', () => {
    expect(
      () => new LocalKeyProvider({ masterKey: Buffer.alloc(16), activeKeyVersion: 1 }),
    ).toThrow();
  });

  it('rejects a non-positive key_version', async () => {
    await expect(provider().getDek(0)).rejects.toThrow();
  });
});
