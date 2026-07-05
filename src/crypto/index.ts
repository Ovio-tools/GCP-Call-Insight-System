/**
 * Envelope encryption for the two encrypted stores (raw_transcripts, token_vault).
 *
 * Rows store `ciphertext` + `key_version`; the DEK for a version is fetched from a
 * {@link KeyProvider} that unwraps it via the external KEK. No key bytes ever live in
 * Postgres. See CLAUDE.md §5; the real KMS provider is Task 8.2.
 */
export { encrypt, encryptUnderVersion, decrypt, type Encrypted } from './envelope.js';
export {
  DEK_BYTES,
  LocalKeyProvider,
  keyProviderFromConfig,
  keyStoreFromConfig,
  buildKeyProvider,
  type KeyProvider,
  type LocalKeyProviderOptions,
} from './key-provider.js';
export {
  LocalFileKeyStore,
  type KeyStore,
  type Clock,
  type Recoverability,
  type RecoverabilityQuery,
  type CreateKekResult,
  type CreateDekResult,
} from './key-store.js';
export { KeyStoreProvider, type KeyStoreProviderOptions } from './key-store-provider.js';
