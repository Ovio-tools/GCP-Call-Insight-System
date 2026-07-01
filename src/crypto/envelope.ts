import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

/** AES-256-GCM parameters. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/** Result of {@link encrypt}: the bytes to store, plus the key_version to record. */
export interface Encrypted {
  /** `iv(12) ‖ authTag(16) ‖ ciphertext` — store directly in a `bytea` column. */
  ciphertext: Buffer;
  /** The key_version the payload was encrypted under (FK into key_versions). */
  keyVersion: number;
}

/** Bind the ciphertext to its key_version (and any caller context) via GCM AAD, so a
 * payload can't be silently reinterpreted under a different version/context. */
function buildAad(keyVersion: number, aad: Buffer | undefined): Buffer {
  const versionTag = Buffer.from(`v${keyVersion}`, 'utf8');
  return aad ? Buffer.concat([versionTag, aad]) : versionTag;
}

/**
 * Envelope-encrypt `plaintext` under the provider's current DEK. Returns the packed
 * ciphertext and the `keyVersion` the caller must persist alongside it. `aad` (e.g. a
 * call_id) is authenticated but not encrypted, and must be supplied identically to
 * {@link decrypt}.
 */
export async function encrypt(
  plaintext: Buffer,
  keyProvider: KeyProvider,
  aad?: Buffer,
): Promise<Encrypted> {
  const keyVersion = await keyProvider.currentKeyVersion();
  const dek = await keyProvider.getDek(keyVersion);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(buildAad(keyVersion, aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([iv, authTag, body]), keyVersion };
}

/**
 * Decrypt a payload produced by {@link encrypt}. Verifies the GCM auth tag — a tampered
 * ciphertext, wrong `keyVersion`, or mismatched `aad` throws rather than returning
 * corrupt plaintext.
 */
export async function decrypt(
  enc: { ciphertext: Buffer; keyVersion: number },
  keyProvider: KeyProvider,
  aad?: Buffer,
): Promise<Buffer> {
  if (enc.ciphertext.length < IV_BYTES + TAG_BYTES) {
    throw new Error('decrypt: ciphertext too short to contain IV + auth tag');
  }
  const iv = enc.ciphertext.subarray(0, IV_BYTES);
  const authTag = enc.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = enc.ciphertext.subarray(IV_BYTES + TAG_BYTES);
  const dek = await keyProvider.getDek(enc.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAAD(buildAad(enc.keyVersion, aad));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
