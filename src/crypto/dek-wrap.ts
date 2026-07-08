import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM wrap parameters (mirror src/crypto/envelope.ts and the key stores). */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/** Additional authenticated data binding a wrapped DEK to its version. */
function aad(keyVersion: number): Buffer {
  return Buffer.from(`dek:v${keyVersion}`, 'utf8');
}

/** Wrap a plaintext DEK under a KEK. Layout: iv | authTag | ciphertext. */
export function wrapDek(dek: Buffer, kek: Buffer, keyVersion: number): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  cipher.setAAD(aad(keyVersion));
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Unwrap a DEK. Throws if the KEK is wrong, the version mismatches, or the tag fails. */
export function unwrapDek(wrapped: Buffer, kek: Buffer, keyVersion: number): Buffer {
  if (wrapped.length < IV_BYTES + TAG_BYTES) {
    throw new Error('key store: wrapped DEK too short');
  }
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, kek, iv);
  decipher.setAAD(aad(keyVersion));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
