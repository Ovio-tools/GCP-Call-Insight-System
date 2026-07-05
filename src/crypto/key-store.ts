import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DEK_BYTES } from './key-provider.js';

/**
 * External key store (KEK + wrapped DEKs) — the seam a real KMS implements later (Task 8.2b).
 *
 * The store is the ONLY place key material lives. Postgres holds refs + metadata only; a KEK is
 * the root wrapping key (stored as raw secret bytes in the store) and each DEK is AES-256-GCM
 * wrapped by its KEK. Destroying the external material for a version is what makes a pre-purge
 * backup honest: the ciphertext survives in the backup but is unreadable everywhere once the
 * DEK (or its KEK) is gone — even though the DB is otherwise intact (crypto-shredding).
 *
 * Destruction is TWO-STATE and recovery-windowed: `destroyDek`/`destroyKek` move the material to a
 * pending-delete area and stamp `recoveryWindowUntil`; `recoverability` reports `recoverable:true`
 * until the (injectable) clock passes that instant, then lazily purges and reports
 * `recoverable:false`. A zero-day window destroys immediately.
 */
export interface CreateKekResult {
  /** Opaque external-store pointer to the new KEK (stored in kek_versions.external_kek_ref). */
  kekRef: string;
}
export interface CreateDekResult {
  /** Opaque external-store pointer to the wrapped DEK (stored in key_versions.wrapped_dek_ref). */
  wrappedRef: string;
}
export type RecoverabilityQuery =
  | { type: 'dek'; keyVersion: number }
  | { type: 'kek'; kekVersion: string };
export interface Recoverability {
  /** Whether the key material can still be retrieved (unwrapped/read) right now. */
  recoverable: boolean;
  /** When the pending-delete window elapses (recoverable flips false), or null if not pending. */
  recoveryWindowUntil: Date | null;
}

export interface KeyStore {
  createKek(args: { kekVersion: string }): Promise<CreateKekResult>;
  /** Raw KEK bytes — in-memory only, used to wrap/unwrap DEKs. Never persisted outside the store. */
  getKek(kekVersion: string): Promise<Buffer>;
  destroyKek(kekVersion: string): Promise<void>;
  createDek(args: { keyVersion: number; kekVersion: string }): Promise<CreateDekResult>;
  /** Plaintext DEK (32 bytes) for a key_version. Throws if destroyed or its KEK is gone. */
  unwrapDek(keyVersion: number): Promise<Buffer>;
  destroyDek(keyVersion: number): Promise<void>;
  recoverability(query: RecoverabilityQuery): Promise<Recoverability>;
}

/** Wall-clock seam so recovery-window timing is testable without real time. */
export interface Clock {
  now(): Date;
}
const REAL_CLOCK: Clock = { now: () => new Date() };

export interface LocalFileKeyStoreOptions {
  /** Directory that IS the external secret store (holds KEK bytes + wrapped DEK files). */
  dir: string;
  /** Mandatory recovery window before destroyed material is truly purged. 0 = immediate. */
  recoveryWindowDays: number;
  clock?: Clock;
  /** TTL for the in-memory unwrapped-DEK cache; expiry is measured on `clock`. */
  unwrapCacheTtlMs?: number;
}

/** AES-256-GCM wrap parameters (mirror src/crypto/envelope.ts). */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';
const KEK_BYTES = 32;
const DEFAULT_UNWRAP_TTL_MS = 5 * 60 * 1000;

interface DekMeta {
  kekVersion: string;
  /** Present only for pending-delete DEKs. ISO string. */
  recoveryWindowUntil?: string;
}
interface KekMeta {
  /** Present only for pending-delete KEKs. ISO string. */
  recoveryWindowUntil?: string;
}

/**
 * Reference {@link KeyStore} — dev/staging ONLY, never production. The directory is the external
 * secret store: the KEK bytes live in a strict-0600 file (legitimately — that is its job, and it
 * is outside Postgres backups) and each DEK is stored ONLY as AES-256-GCM-wrapped material. No key
 * bytes ever touch Postgres, logs, errors, or lifecycle events. Production is Task 8.2b.
 */
export class LocalFileKeyStore implements KeyStore {
  readonly #dir: string;
  readonly #recoveryWindowMs: number;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #dekCache = new Map<number, { dek: Buffer; expiresMs: number }>();

  constructor(opts: LocalFileKeyStoreOptions) {
    if (!Number.isInteger(opts.recoveryWindowDays) || opts.recoveryWindowDays < 0) {
      throw new Error('LocalFileKeyStore: recoveryWindowDays must be an integer >= 0');
    }
    this.#dir = opts.dir;
    this.#recoveryWindowMs = opts.recoveryWindowDays * 24 * 60 * 60 * 1000;
    this.#clock = opts.clock ?? REAL_CLOCK;
    this.#ttlMs = opts.unwrapCacheTtlMs ?? DEFAULT_UNWRAP_TTL_MS;
    mkdirSync(join(this.#dir, 'kek', 'pending'), { recursive: true });
    mkdirSync(join(this.#dir, 'dek', 'pending'), { recursive: true });
  }

  // --- paths ---
  #kekPath(v: string, pending = false): string {
    return join(this.#dir, 'kek', pending ? 'pending' : '', `${v}.key`);
  }
  #kekMetaPath(v: string, pending = false): string {
    return join(this.#dir, 'kek', pending ? 'pending' : '', `${v}.meta.json`);
  }
  #dekPath(v: number, pending = false): string {
    return join(this.#dir, 'dek', pending ? 'pending' : '', `v${v}.wrapped`);
  }
  #dekMetaPath(v: number, pending = false): string {
    return join(this.#dir, 'dek', pending ? 'pending' : '', `v${v}.meta.json`);
  }

  // --- KEK ---
  createKek({ kekVersion }: { kekVersion: string }): Promise<CreateKekResult> {
    const path = this.#kekPath(kekVersion);
    if (existsSync(path)) {
      return Promise.reject(new Error(`key store: KEK ${kekVersion} already exists`));
    }
    writeFileSync(path, randomBytes(KEK_BYTES), { mode: 0o600 });
    chmodSync(path, 0o600);
    return Promise.resolve({ kekRef: `kek:${kekVersion}` });
  }

  getKek(kekVersion: string): Promise<Buffer> {
    const active = this.#kekPath(kekVersion);
    if (existsSync(active)) return Promise.resolve(readFileSync(active));
    // Pending-delete KEK: readable until the window elapses, then purged.
    const pending = this.#kekPath(kekVersion, true);
    if (existsSync(pending)) {
      if (this.#windowElapsed(this.#kekMetaPath(kekVersion, true))) {
        this.#purgeKek(kekVersion);
        return Promise.reject(new Error(`key store: KEK ${kekVersion} has been destroyed`));
      }
      return Promise.resolve(readFileSync(pending));
    }
    return Promise.reject(new Error(`key store: KEK ${kekVersion} not found`));
  }

  destroyKek(kekVersion: string): Promise<void> {
    const active = this.#kekPath(kekVersion);
    if (existsSync(active)) {
      const until = new Date(this.#clock.now().getTime() + this.#recoveryWindowMs);
      renameSync(active, this.#kekPath(kekVersion, true));
      const meta: KekMeta = { recoveryWindowUntil: until.toISOString() };
      writeFileSync(this.#kekMetaPath(kekVersion, true), JSON.stringify(meta), { mode: 0o600 });
    }
    this.#dekCache.clear();
    // Immediate window → purge now so recoverability is false without a further tick.
    if (this.#windowElapsed(this.#kekMetaPath(kekVersion, true))) this.#purgeKek(kekVersion);
    return Promise.resolve();
  }

  // --- DEK ---
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
    if (existsSync(this.#dekPath(keyVersion))) {
      throw new Error(`key store: DEK v${keyVersion} already exists`);
    }
    const kek = await this.getKek(kekVersion);
    const dek = randomBytes(DEK_BYTES);
    const wrapped = this.#wrap(dek, kek, keyVersion);
    writeFileSync(this.#dekPath(keyVersion), wrapped, { mode: 0o600 });
    const meta: DekMeta = { kekVersion };
    writeFileSync(this.#dekMetaPath(keyVersion), JSON.stringify(meta), { mode: 0o600 });
    return { wrappedRef: `dek:v${keyVersion}` };
  }

  async unwrapDek(keyVersion: number): Promise<Buffer> {
    const cached = this.#dekCache.get(keyVersion);
    if (cached && this.#clock.now().getTime() < cached.expiresMs) return cached.dek;

    const resolved = this.#resolveDek(keyVersion);
    if (!resolved) throw new Error(`key store: DEK v${keyVersion} is not recoverable`);
    const meta = JSON.parse(readFileSync(resolved.metaPath, 'utf8')) as DekMeta;
    const kek = await this.getKek(meta.kekVersion); // throws if the KEK was destroyed
    const dek = this.#unwrap(readFileSync(resolved.wrappedPath), kek, keyVersion);
    this.#dekCache.set(keyVersion, {
      dek,
      expiresMs: this.#clock.now().getTime() + this.#ttlMs,
    });
    return dek;
  }

  destroyDek(keyVersion: number): Promise<void> {
    const active = this.#dekPath(keyVersion);
    if (existsSync(active)) {
      const until = new Date(this.#clock.now().getTime() + this.#recoveryWindowMs);
      const meta = JSON.parse(readFileSync(this.#dekMetaPath(keyVersion), 'utf8')) as DekMeta;
      renameSync(active, this.#dekPath(keyVersion, true));
      const pendingMeta: DekMeta = {
        kekVersion: meta.kekVersion,
        recoveryWindowUntil: until.toISOString(),
      };
      writeFileSync(this.#dekMetaPath(keyVersion, true), JSON.stringify(pendingMeta), {
        mode: 0o600,
      });
      rmSync(this.#dekMetaPath(keyVersion), { force: true });
    }
    this.#dekCache.delete(keyVersion);
    if (this.#windowElapsed(this.#dekMetaPath(keyVersion, true))) this.#purgeDek(keyVersion);
    return Promise.resolve();
  }

  async recoverability(query: RecoverabilityQuery): Promise<Recoverability> {
    if (query.type === 'kek') {
      const active = this.#kekPath(query.kekVersion);
      if (existsSync(active)) return { recoverable: true, recoveryWindowUntil: null };
      const pendingMeta = this.#kekMetaPath(query.kekVersion, true);
      if (existsSync(this.#kekPath(query.kekVersion, true))) {
        if (this.#windowElapsed(pendingMeta)) {
          this.#purgeKek(query.kekVersion);
          return { recoverable: false, recoveryWindowUntil: null };
        }
        return { recoverable: true, recoveryWindowUntil: this.#windowUntil(pendingMeta) };
      }
      return { recoverable: false, recoveryWindowUntil: null };
    }

    const resolved = this.#resolveDek(query.keyVersion);
    if (!resolved) return { recoverable: false, recoveryWindowUntil: null };
    // Honest: a DEK is only recoverable while its KEK is too.
    const meta = JSON.parse(readFileSync(resolved.metaPath, 'utf8')) as DekMeta;
    const kekRec = await this.recoverability({ type: 'kek', kekVersion: meta.kekVersion });
    if (!kekRec.recoverable) return { recoverable: false, recoveryWindowUntil: null };
    return {
      recoverable: true,
      recoveryWindowUntil: resolved.pending
        ? this.#windowUntil(this.#dekMetaPath(query.keyVersion, true))
        : null,
    };
  }

  // --- internals ---
  /** Readable location of a DEK, lazily purging a pending one whose window elapsed. */
  #resolveDek(v: number): { wrappedPath: string; metaPath: string; pending: boolean } | null {
    const active = this.#dekPath(v);
    if (existsSync(active)) {
      return { wrappedPath: active, metaPath: this.#dekMetaPath(v), pending: false };
    }
    const pending = this.#dekPath(v, true);
    if (existsSync(pending)) {
      if (this.#windowElapsed(this.#dekMetaPath(v, true))) {
        this.#purgeDek(v);
        return null;
      }
      return { wrappedPath: pending, metaPath: this.#dekMetaPath(v, true), pending: true };
    }
    return null;
  }

  #windowUntil(metaPath: string): Date | null {
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { recoveryWindowUntil?: string };
    return meta.recoveryWindowUntil ? new Date(meta.recoveryWindowUntil) : null;
  }
  #windowElapsed(metaPath: string): boolean {
    const until = this.#windowUntil(metaPath);
    if (!until) return false;
    return this.#clock.now().getTime() >= until.getTime();
  }
  #purgeDek(v: number): void {
    rmSync(this.#dekPath(v, true), { force: true });
    rmSync(this.#dekMetaPath(v, true), { force: true });
    this.#dekCache.delete(v);
  }
  #purgeKek(v: string): void {
    rmSync(this.#kekPath(v, true), { force: true });
    rmSync(this.#kekMetaPath(v, true), { force: true });
    this.#dekCache.clear();
  }

  #wrap(dek: Buffer, kek: Buffer, keyVersion: number): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, kek, iv);
    cipher.setAAD(Buffer.from(`dek:v${keyVersion}`, 'utf8'));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  #unwrap(wrapped: Buffer, kek: Buffer, keyVersion: number): Buffer {
    if (wrapped.length < IV_BYTES + TAG_BYTES) {
      throw new Error('key store: wrapped DEK too short');
    }
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAAD(Buffer.from(`dek:v${keyVersion}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}
