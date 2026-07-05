import type { KeyProvider } from './key-provider.js';
import type { Clock, KeyStore } from './key-store.js';

const REAL_CLOCK: Clock = { now: () => new Date() };
const DEFAULT_ACTIVE_TTL_MS = 5_000;

export interface KeyStoreProviderOptions {
  keyStore: KeyStore;
  /**
   * DB-sourced active key_version — the single `status='active'` row. MUST fail loudly (throw) on
   * zero or multiple active rows; the provider never falls back to a config value.
   */
  loadActiveKeyVersion: () => Promise<number>;
  clock?: Clock;
  /** Short TTL for the active-version cache; default 5s. Kept short so a rotation is picked up. */
  activeVersionTtlMs?: number;
}

/**
 * {@link KeyProvider} backed by the external {@link KeyStore} and a DB-sourced active version.
 *
 * `currentKeyVersion()` reads the single `status='active'` row (short-TTL cached so hot write
 * paths don't hit the DB every call); `getDek()` unwraps via the key store (which holds its own
 * bounded, TTL'd DEK cache). Rotation calls {@link invalidateActiveVersion} after it flips the
 * active row so the next write encrypts under the new version without waiting out the TTL.
 */
export class KeyStoreProvider implements KeyProvider {
  readonly #keyStore: KeyStore;
  readonly #load: () => Promise<number>;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #cached: { version: number; expiresMs: number } | null = null;

  constructor(opts: KeyStoreProviderOptions) {
    this.#keyStore = opts.keyStore;
    this.#load = opts.loadActiveKeyVersion;
    this.#clock = opts.clock ?? REAL_CLOCK;
    this.#ttlMs = opts.activeVersionTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
  }

  getDek(keyVersion: number): Promise<Buffer> {
    return this.#keyStore.unwrapDek(keyVersion);
  }

  async currentKeyVersion(): Promise<number> {
    const nowMs = this.#clock.now().getTime();
    if (this.#cached && nowMs < this.#cached.expiresMs) return this.#cached.version;
    const version = await this.#load();
    this.#cached = { version, expiresMs: nowMs + this.#ttlMs };
    return version;
  }

  /** Rotation hook — drop the cached active version so the next write re-reads it from the DB. */
  invalidateActiveVersion(): void {
    this.#cached = null;
  }
}
