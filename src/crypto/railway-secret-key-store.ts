import { randomBytes } from 'node:crypto';
import { DEK_BYTES } from './key-provider.js';
import { wrapDek, unwrapDek } from './dek-wrap.js';
import type {
  CreateDekResult,
  CreateKekResult,
  Clock,
  KeyStore,
  Recoverability,
  RecoverabilityQuery,
} from './key-store.js';
import { ReadOnlySecretBackendError, type SecretBackend } from './secret-backend.js';

const KEK_BYTES = 32;
const DEFAULT_UNWRAP_TTL_MS = 5 * 60 * 1000;
const REAL_CLOCK: Clock = { now: () => new Date() };

interface KekEntry {
  bytes: string;
  recoveryWindowUntil?: string;
}
interface DekEntry {
  wrapped: string;
  kekVersion: string;
  recoveryWindowUntil?: string;
}
interface KekDoc {
  active: Record<string, KekEntry>;
  pending: Record<string, KekEntry>;
}
interface DekDoc {
  active: Record<string, DekEntry>;
  pending: Record<string, DekEntry>;
}

export interface RailwaySecretKeyStoreOptions {
  backend: SecretBackend;
  kekSecretName: string;
  dekSecretName: string;
  recoveryWindowDays: number;
  clock?: Clock;
  unwrapCacheTtlMs?: number;
}

/**
 * Production-capable KeyStore backed by Railway Secrets. Mirrors LocalFileKeyStore's two-state,
 * recovery-windowed destruction, but persists two JSON documents through a SecretBackend instead
 * of files. Never logs key material.
 */
export class RailwaySecretKeyStore implements KeyStore {
  readonly #backend: SecretBackend;
  readonly #kekName: string;
  readonly #dekName: string;
  readonly #recoveryWindowMs: number;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #dekCache = new Map<number, { dek: Buffer; expiresMs: number }>();

  constructor(opts: RailwaySecretKeyStoreOptions) {
    if (!Number.isInteger(opts.recoveryWindowDays) || opts.recoveryWindowDays < 0) {
      throw new Error('RailwaySecretKeyStore: recoveryWindowDays must be an integer >= 0');
    }
    this.#backend = opts.backend;
    this.#kekName = opts.kekSecretName;
    this.#dekName = opts.dekSecretName;
    this.#recoveryWindowMs = opts.recoveryWindowDays * 24 * 60 * 60 * 1000;
    this.#clock = opts.clock ?? REAL_CLOCK;
    this.#ttlMs = opts.unwrapCacheTtlMs ?? DEFAULT_UNWRAP_TTL_MS;
  }

  async #readKekDoc(): Promise<KekDoc> {
    const raw = await this.#backend.read(this.#kekName);
    if (!raw) return { active: {}, pending: {} };
    let doc: Partial<KekDoc>;
    try {
      doc = JSON.parse(raw) as Partial<KekDoc>;
    } catch {
      // Never surface the caught SyntaxError — its message embeds a fragment of the input,
      // which is base64 key material.
      throw new Error(`secret "${this.#kekName}" is not valid JSON`);
    }
    return { active: doc.active ?? {}, pending: doc.pending ?? {} };
  }
  async #writeKekDoc(doc: KekDoc): Promise<void> {
    await this.#backend.write(this.#kekName, JSON.stringify(doc));
  }
  async #readDekDoc(): Promise<DekDoc> {
    const raw = await this.#backend.read(this.#dekName);
    if (!raw) return { active: {}, pending: {} };
    let doc: Partial<DekDoc>;
    try {
      doc = JSON.parse(raw) as Partial<DekDoc>;
    } catch {
      // Never surface the caught SyntaxError — its message embeds a fragment of the input,
      // which is base64-wrapped key material.
      throw new Error(`secret "${this.#dekName}" is not valid JSON`);
    }
    return { active: doc.active ?? {}, pending: doc.pending ?? {} };
  }
  async #writeDekDoc(doc: DekDoc): Promise<void> {
    await this.#backend.write(this.#dekName, JSON.stringify(doc));
  }

  #elapsed(recoveryWindowUntil: string | undefined): boolean {
    if (!recoveryWindowUntil) return false;
    return this.#clock.now().getTime() >= new Date(recoveryWindowUntil).getTime();
  }
  #windowUntil(recoveryWindowUntil: string | undefined): Date | null {
    return recoveryWindowUntil ? new Date(recoveryWindowUntil) : null;
  }
  async #tryWrite(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      if (err instanceof ReadOnlySecretBackendError) return;
      throw err;
    }
  }

  async createKek({ kekVersion }: { kekVersion: string }): Promise<CreateKekResult> {
    const doc = await this.#readKekDoc();
    if (doc.active[kekVersion] || doc.pending[kekVersion]) {
      throw new Error(`key store: KEK ${kekVersion} already exists`);
    }
    doc.active[kekVersion] = { bytes: randomBytes(KEK_BYTES).toString('base64') };
    await this.#writeKekDoc(doc);
    return { kekRef: `kek:${kekVersion}` };
  }

  async getKek(kekVersion: string): Promise<Buffer> {
    const doc = await this.#readKekDoc();
    const active = doc.active[kekVersion];
    if (active) return Buffer.from(active.bytes, 'base64');
    const pending = doc.pending[kekVersion];
    if (pending) {
      if (this.#elapsed(pending.recoveryWindowUntil)) {
        delete doc.pending[kekVersion];
        await this.#tryWrite(() => this.#writeKekDoc(doc));
        this.#dekCache.clear();
        throw new Error(`key store: KEK ${kekVersion} has been destroyed`);
      }
      return Buffer.from(pending.bytes, 'base64');
    }
    throw new Error(`key store: KEK ${kekVersion} not found`);
  }

  async destroyKek(kekVersion: string): Promise<void> {
    const doc = await this.#readKekDoc();
    const active = doc.active[kekVersion];
    if (active) {
      const until = new Date(this.#clock.now().getTime() + this.#recoveryWindowMs).toISOString();
      delete doc.active[kekVersion];
      doc.pending[kekVersion] = { bytes: active.bytes, recoveryWindowUntil: until };
    }
    // Physically shred bytes once the window has elapsed. Covers the zero-day case AND a finalizer
    // re-invocation after the window passes (active is absent, but the elapsed pending is purged) —
    // the finalizer confirms via destroyKek + recoverability and never calls getKek, so this is the
    // path that actually removes the raw bytes from the secret document.
    const pending = doc.pending[kekVersion];
    if (pending && this.#elapsed(pending.recoveryWindowUntil)) delete doc.pending[kekVersion];
    await this.#writeKekDoc(doc);
    this.#dekCache.clear();
  }

  /**
   * Readable DEK entry (active or in-window pending), or null if absent/elapsed. An elapsed pending
   * entry is best-effort physically purged (bytes removed) before returning null — mirroring
   * LocalFileKeyStore.#resolveDek so a read path also shreds material a destroy never finalized.
   */
  async #resolveDek(keyVersion: number): Promise<DekEntry | null> {
    const doc = await this.#readDekDoc();
    const active = doc.active[keyVersion];
    if (active) return active;
    const pending = doc.pending[keyVersion];
    if (pending) {
      if (!this.#elapsed(pending.recoveryWindowUntil)) return pending;
      delete doc.pending[keyVersion];
      await this.#tryWrite(() => this.#writeDekDoc(doc));
    }
    return null;
  }

  async createDek({
    keyVersion,
    kekVersion,
  }: {
    keyVersion: number;
    kekVersion: string;
  }): Promise<CreateDekResult> {
    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
      throw new Error('key store: keyVersion must be a positive integer');
    }
    const doc = await this.#readDekDoc();
    if (doc.active[keyVersion] || doc.pending[keyVersion]) {
      throw new Error(`key store: DEK v${keyVersion} already exists`);
    }
    const kek = await this.getKek(kekVersion);
    const dek = randomBytes(DEK_BYTES);
    const wrapped = wrapDek(dek, kek, keyVersion);
    doc.active[keyVersion] = { wrapped: wrapped.toString('base64'), kekVersion };
    await this.#writeDekDoc(doc);
    return { wrappedRef: `dek:v${keyVersion}` };
  }

  async unwrapDek(keyVersion: number): Promise<Buffer> {
    const cached = this.#dekCache.get(keyVersion);
    if (cached && this.#clock.now().getTime() < cached.expiresMs) return cached.dek;
    const entry = await this.#resolveDek(keyVersion);
    if (!entry) throw new Error(`key store: DEK v${keyVersion} is not recoverable`);
    const kek = await this.getKek(entry.kekVersion);
    const dek = unwrapDek(Buffer.from(entry.wrapped, 'base64'), kek, keyVersion);
    this.#dekCache.set(keyVersion, { dek, expiresMs: this.#clock.now().getTime() + this.#ttlMs });
    return dek;
  }

  async destroyDek(keyVersion: number): Promise<void> {
    const doc = await this.#readDekDoc();
    const active = doc.active[keyVersion];
    if (active) {
      const until = new Date(this.#clock.now().getTime() + this.#recoveryWindowMs).toISOString();
      delete doc.active[keyVersion];
      doc.pending[keyVersion] = {
        wrapped: active.wrapped,
        kekVersion: active.kekVersion,
        recoveryWindowUntil: until,
      };
    }
    const pending = doc.pending[keyVersion];
    if (pending && this.#elapsed(pending.recoveryWindowUntil)) delete doc.pending[keyVersion];
    await this.#writeDekDoc(doc);
    this.#dekCache.delete(keyVersion);
  }

  async recoverability(query: RecoverabilityQuery): Promise<Recoverability> {
    if (query.type === 'kek') {
      const doc = await this.#readKekDoc();
      if (doc.active[query.kekVersion]) return { recoverable: true, recoveryWindowUntil: null };
      const pending = doc.pending[query.kekVersion];
      if (pending) {
        if (!this.#elapsed(pending.recoveryWindowUntil)) {
          return {
            recoverable: true,
            recoveryWindowUntil: this.#windowUntil(pending.recoveryWindowUntil),
          };
        }
        // Elapsed: best-effort physically purge the bytes before reporting unrecoverable. This is
        // the path the finalizer (destroyKek + recoverability, never getKek) relies on to leave no
        // raw KEK bytes behind in the secret document.
        delete doc.pending[query.kekVersion];
        await this.#tryWrite(() => this.#writeKekDoc(doc));
        this.#dekCache.clear();
      }
      return { recoverable: false, recoveryWindowUntil: null };
    }
    const entry = await this.#resolveDek(query.keyVersion);
    if (!entry) return { recoverable: false, recoveryWindowUntil: null };
    const kekRec = await this.recoverability({ type: 'kek', kekVersion: entry.kekVersion });
    if (!kekRec.recoverable) return { recoverable: false, recoveryWindowUntil: null };
    return { recoverable: true, recoveryWindowUntil: this.#windowUntil(entry.recoveryWindowUntil) };
  }
}
