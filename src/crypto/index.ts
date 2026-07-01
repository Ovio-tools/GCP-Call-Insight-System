/**
 * Envelope encryption for the two encrypted stores (raw_transcripts, token_vault).
 *
 * Rows store `ciphertext` + `key_version`; the DEK for a version is fetched from a
 * {@link KeyProvider} that unwraps it via the external KEK. No key bytes ever live in
 * Postgres. See CLAUDE.md §5; the real KMS provider is Task 8.2.
 */
export { encrypt, decrypt, type Encrypted } from './envelope.js';
export {
  DEK_BYTES,
  LocalKeyProvider,
  keyProviderFromConfig,
  type KeyProvider,
  type LocalKeyProviderOptions,
} from './key-provider.js';
