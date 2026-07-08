# Railway-Secret Key Store — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-usable key store backed by Railway Secrets so the system can go live without a dedicated cloud KMS, and flip the launch gate to accept it.

**Architecture:** A new `RailwaySecretKeyStore` implements the existing `KeyStore` seam (`src/crypto/key-store.ts`) exactly as `LocalFileKeyStore` does, but stores key material in two versioned JSON "secret documents" instead of files. It reads/writes those documents through a small `SecretBackend` seam with three implementations: `InMemorySecretBackend` (tests), `EnvSecretBackend` (read-only, used by running services that only unwrap), and `RailwayApiSecretBackend` (read+write, used by the key-lifecycle CLIs). `CRYPTO_KEY_PROVIDER=railway` becomes the one provider accepted in production; the crypto-shred launch gate is updated to pass on it. Task 8.2b (external KMS) is downgraded to an optional future upgrade.

**Tech Stack:** Node.js + TypeScript (strict), vitest, zod config, AES-256-GCM (node:crypto), pg, Railway GraphQL API (via global `fetch`).

**Companion spec:** `docs/superpowers/specs/2026-07-08-railway-secret-keystore-and-raw-store-isolation-design.md` (Move 1 only; Move 2 — the raw-store DB split — is Plan 2).

---

## File Structure

**Create:**
- `src/crypto/dek-wrap.ts` — shared AES-256-GCM wrap/unwrap helpers for a DEK under a KEK (extracted so both key stores share one copy).
- `src/crypto/secret-backend.ts` — `SecretBackend` interface + `InMemorySecretBackend` + `EnvSecretBackend` + `ReadOnlySecretBackendError`.
- `src/crypto/railway-secret-key-store.ts` — `RailwaySecretKeyStore` (the new `KeyStore`).
- `src/crypto/railway-api-secret-backend.ts` — `RailwayApiSecretBackend` (Railway GraphQL adapter).
- `test/crypto/secret-backend.test.ts`
- `test/crypto/railway-secret-key-store.test.ts`
- `test/crypto/railway-api-secret-backend.test.ts`
- `docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md`

**Modify:**
- `src/crypto/key-store.ts` — use the shared `dek-wrap.ts` helpers (drop the private `#wrap`/`#unwrap`).
- `src/crypto/key-provider.ts` — `keyStoreFromConfig` + `buildKeyProvider` handle `'railway'`; add `isKeyStoreProvider` helper.
- `src/crypto/index.ts` — export the new symbols.
- `src/config/schema.ts` — add `'railway'` to the provider enum + new key-material/Railway-API settings.
- `src/key-lifecycle/launch-gate.ts` — accept `railway` in production.
- `src/key-lifecycle/readiness.ts` — treat `railway` as a keystore-family provider.
- `src/scripts/bootstrap-key.ts`, `rotate-kek.ts`, `rotate-key.ts`, `revoke-key.ts`, `confirm-destruction.ts` — accept `railway`; build the Railway-API backend for `railway`.
- `test/key-lifecycle/launch-gate.test.ts` — add production+railway pass and production+keystore fail cases.
- `.env.example`, `CLAUDE.md`, `docs/task-8-2b-production-kms.md` — config + disposition updates.

---

## Task 1: Extract shared DEK wrap/unwrap helpers

**Files:**
- Create: `src/crypto/dek-wrap.ts`
- Modify: `src/crypto/key-store.ts` (replace the private `#wrap`/`#unwrap` with the shared helpers)
- Test (safety net): existing `test/crypto/key-store.test.ts` (unchanged — proves the refactor is behavior-preserving)

- [ ] **Step 1: Write `src/crypto/dek-wrap.ts`**

```typescript
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
```

- [ ] **Step 2: Refactor `LocalFileKeyStore` to use the shared helpers**

In `src/crypto/key-store.ts`: add `import { wrapDek, unwrapDek } from './dek-wrap.js';` at the top. Delete the private `#wrap` and `#unwrap` methods (lines ~296–314). Replace their two call sites:
- in `createDek`: `const wrapped = this.#wrap(dek, kek, keyVersion);` → `const wrapped = wrapDek(dek, kek, keyVersion);`
- in `unwrapDek`: `const dek = this.#unwrap(readFileSync(resolved.wrappedPath), kek, keyVersion);` → `const dek = unwrapDek(readFileSync(resolved.wrappedPath), kek, keyVersion);`

The local `IV_BYTES`/`TAG_BYTES`/`ALGORITHM` constants in `key-store.ts` are now only used by `#wrap`/`#unwrap`; remove any that become unused (keep `KEK_BYTES` and `DEFAULT_UNWRAP_TTL_MS`, still used elsewhere). Run typecheck to catch stragglers.

- [ ] **Step 3: Run the existing key-store suite to prove behavior is unchanged**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/crypto/key-store.test.ts`
Expected: PASS (same count as before the refactor).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/crypto/dek-wrap.ts src/crypto/key-store.ts
git commit -m "refactor(crypto): extract shared DEK wrap/unwrap helpers"
```

---

## Task 2: The `SecretBackend` seam

**Files:**
- Create: `src/crypto/secret-backend.ts`
- Test: `test/crypto/secret-backend.test.ts`

- [ ] **Step 1: Write the failing test `test/crypto/secret-backend.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import {
  EnvSecretBackend,
  InMemorySecretBackend,
  ReadOnlySecretBackendError,
} from '../../src/crypto/secret-backend.js';

describe('InMemorySecretBackend', () => {
  it('returns undefined for an unset name and round-trips writes', async () => {
    const backend = new InMemorySecretBackend();
    expect(await backend.read('A')).toBeUndefined();
    await backend.write('A', 'value-1');
    expect(await backend.read('A')).toBe('value-1');
    await backend.write('A', 'value-2');
    expect(await backend.read('A')).toBe('value-2');
  });
});

describe('EnvSecretBackend', () => {
  it('reads from the supplied values map', async () => {
    const backend = new EnvSecretBackend({ A: 'x', B: undefined });
    expect(await backend.read('A')).toBe('x');
    expect(await backend.read('B')).toBeUndefined();
    expect(await backend.read('C')).toBeUndefined();
  });

  it('rejects writes with ReadOnlySecretBackendError', async () => {
    const backend = new EnvSecretBackend({ A: 'x' });
    await expect(backend.write('A', 'y')).rejects.toBeInstanceOf(ReadOnlySecretBackendError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crypto/secret-backend.test.ts`
Expected: FAIL — cannot find module `secret-backend.js`.

- [ ] **Step 3: Write `src/crypto/secret-backend.ts`**

```typescript
/**
 * Storage seam for the RailwaySecretKeyStore. A backend holds named secret values (opaque JSON
 * strings). Running services get a read-only view of the values injected at boot; the key-lifecycle
 * CLIs get a read+write view backed by the Railway API. Never logs values — they are key material.
 */
export interface SecretBackend {
  /** Current value for `name`, or undefined if unset. */
  read(name: string): Promise<string | undefined>;
  /** Persist `value` for `name`. Read-only backends reject with {@link ReadOnlySecretBackendError}. */
  write(name: string, value: string): Promise<void>;
}

/** Thrown when a read-only backend (a running service) is asked to mutate key material. */
export class ReadOnlySecretBackendError extends Error {
  constructor(name: string) {
    super(
      `secret backend is read-only for "${name}"; run key changes via a Railway-API-backed CLI, not a service`,
    );
    this.name = 'ReadOnlySecretBackendError';
  }
}

/** In-memory backend for tests. */
export class InMemorySecretBackend implements SecretBackend {
  readonly #values = new Map<string, string>();
  read(name: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(name));
  }
  write(name: string, value: string): Promise<void> {
    this.#values.set(name, value);
    return Promise.resolve();
  }
}

/** Read-only backend over values injected at boot (the two Railway secrets). Used by services. */
export class EnvSecretBackend implements SecretBackend {
  readonly #values: Readonly<Record<string, string | undefined>>;
  constructor(values: Readonly<Record<string, string | undefined>>) {
    this.#values = values;
  }
  read(name: string): Promise<string | undefined> {
    return Promise.resolve(this.#values[name]);
  }
  write(name: string): Promise<void> {
    return Promise.reject(new ReadOnlySecretBackendError(name));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/crypto/secret-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crypto/secret-backend.ts test/crypto/secret-backend.test.ts
git commit -m "feat(crypto): SecretBackend seam (in-memory + read-only env)"
```

---

## Task 3: `RailwaySecretKeyStore` — KEK operations

**Files:**
- Create: `src/crypto/railway-secret-key-store.ts` (KEK ops now; DEK ops + recoverability in Tasks 4–5)
- Test: `test/crypto/railway-secret-key-store.test.ts`

The store keeps two secret documents. Shapes (store-internal):

```
KEK doc:  { active: { [kekVersion]: { bytes } }, pending: { [kekVersion]: { bytes, recoveryWindowUntil } } }
DEK doc:  { active: { [keyVersion]: { wrapped, kekVersion } }, pending: { [keyVersion]: { wrapped, kekVersion, recoveryWindowUntil } } }
```
`bytes`/`wrapped` are base64. Read operations never write; mutations read-modify-write the whole document. Physical removal of an elapsed pending entry is best-effort: attempted on write-capable backends, silently skipped on read-only ones (the launch gate's stalled-destruction check independently catches unfinalized drift).

- [ ] **Step 1: Write the failing test (KEK lifecycle)**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretBackend } from '../../src/crypto/secret-backend.js';
import { RailwaySecretKeyStore } from '../../src/crypto/railway-secret-key-store.js';

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
    const kek = await store.getKek('kek-1');
    expect(kek).toHaveLength(32);
  });

  it('never stores raw KEK bytes in cleartext form the caller passed — bytes are random', async () => {
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
    // within window
    clock.advanceDays(3);
    expect(await store.getKek('kek-1')).toHaveLength(32);
    // past window
    clock.advanceDays(5);
    await expect(store.getKek('kek-1')).rejects.toThrow(/destroyed/);
  });

  it('a zero-day window destroys immediately', async () => {
    const immediate = makeStore(backend, clock, 0);
    await immediate.createKek({ kekVersion: 'kek-1' });
    await immediate.destroyKek('kek-1');
    await expect(immediate.getKek('kek-1')).rejects.toThrow(/destroyed/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: FAIL — cannot find module `railway-secret-key-store.js`.

- [ ] **Step 3: Write `src/crypto/railway-secret-key-store.ts` (KEK ops + shared internals)**

```typescript
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
import {
  ReadOnlySecretBackendError,
  type SecretBackend,
} from './secret-backend.js';

const KEK_BYTES = 32;
const DEFAULT_UNWRAP_TTL_MS = 5 * 60 * 1000;
const REAL_CLOCK: Clock = { now: () => new Date() };

interface KekEntry {
  bytes: string; // base64 KEK bytes
  recoveryWindowUntil?: string; // ISO; present only for pending entries
}
interface DekEntry {
  wrapped: string; // base64 wrapped DEK
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
  /** Secret name holding the KEK document (e.g. CRYPTO_KEK_MATERIAL). */
  kekSecretName: string;
  /** Secret name holding the wrapped-DEK document (e.g. CRYPTO_WRAPPED_DEK_MATERIAL). */
  dekSecretName: string;
  recoveryWindowDays: number;
  clock?: Clock;
  unwrapCacheTtlMs?: number;
}

/**
 * Production-capable {@link KeyStore} backed by Railway Secrets. Mirrors LocalFileKeyStore's
 * two-state, recovery-windowed destruction, but persists two JSON documents through a
 * {@link SecretBackend} instead of files. Never logs key material.
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

  // --- document IO ---
  async #readKekDoc(): Promise<KekDoc> {
    const raw = await this.#backend.read(this.#kekName);
    if (!raw) return { active: {}, pending: {} };
    const doc = JSON.parse(raw) as Partial<KekDoc>;
    return { active: doc.active ?? {}, pending: doc.pending ?? {} };
  }
  async #writeKekDoc(doc: KekDoc): Promise<void> {
    await this.#backend.write(this.#kekName, JSON.stringify(doc));
  }
  async #readDekDoc(): Promise<DekDoc> {
    const raw = await this.#backend.read(this.#dekName);
    if (!raw) return { active: {}, pending: {} };
    const doc = JSON.parse(raw) as Partial<DekDoc>;
    return { active: doc.active ?? {}, pending: doc.pending ?? {} };
  }
  async #writeDekDoc(doc: DekDoc): Promise<void> {
    await this.#backend.write(this.#dekName, JSON.stringify(doc));
  }

  // --- window helpers ---
  #elapsed(recoveryWindowUntil: string | undefined): boolean {
    if (!recoveryWindowUntil) return false;
    return this.#clock.now().getTime() >= new Date(recoveryWindowUntil).getTime();
  }
  #windowUntil(recoveryWindowUntil: string | undefined): Date | null {
    return recoveryWindowUntil ? new Date(recoveryWindowUntil) : null;
  }
  /** Best-effort persist; a read-only backend (service) silently skips the housekeeping write. */
  async #tryWrite(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      if (err instanceof ReadOnlySecretBackendError) return;
      throw err;
    }
  }

  // --- KEK ---
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
    const pending = doc.pending[kekVersion];
    if (pending && this.#elapsed(pending.recoveryWindowUntil)) {
      delete doc.pending[kekVersion];
    }
    await this.#writeKekDoc(doc);
    this.#dekCache.clear();
  }

  // DEK ops and recoverability are added in Tasks 4 and 5.
  createDek(_args: { keyVersion: number; kekVersion: string }): Promise<CreateDekResult> {
    return Promise.reject(new Error('not implemented'));
  }
  unwrapDek(_keyVersion: number): Promise<Buffer> {
    return Promise.reject(new Error('not implemented'));
  }
  destroyDek(_keyVersion: number): Promise<void> {
    return Promise.reject(new Error('not implemented'));
  }
  recoverability(_query: RecoverabilityQuery): Promise<Recoverability> {
    return Promise.reject(new Error('not implemented'));
  }
}
```

- [ ] **Step 4: Run to verify KEK tests pass**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: PASS for the KEK describe block.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck` (expect no errors — the `_args`/`_query` stubs satisfy the interface).

```bash
git add src/crypto/railway-secret-key-store.ts test/crypto/railway-secret-key-store.test.ts
git commit -m "feat(crypto): RailwaySecretKeyStore KEK ops over SecretBackend"
```

---

## Task 4: `RailwaySecretKeyStore` — DEK operations

**Files:**
- Modify: `src/crypto/railway-secret-key-store.ts` (implement `createDek`/`unwrapDek`/`destroyDek`)
- Test: `test/crypto/railway-secret-key-store.test.ts` (add a DEK describe block)

- [ ] **Step 1: Add the failing DEK tests**

Append to `test/crypto/railway-secret-key-store.test.ts`:

```typescript
import { DEK_BYTES } from '../../src/crypto/key-provider.js';

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
    const dek = await store.unwrapDek(1);
    expect(dek).toHaveLength(DEK_BYTES);
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
```

- [ ] **Step 2: Run to verify the DEK tests fail**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implement the DEK methods**

In `src/crypto/railway-secret-key-store.ts`, replace the three `createDek`/`unwrapDek`/`destroyDek` stubs with:

```typescript
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
    const kek = await this.getKek(kekVersion); // throws if the KEK is gone
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
    const kek = await this.getKek(entry.kekVersion); // throws if the KEK was destroyed
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
    if (pending && this.#elapsed(pending.recoveryWindowUntil)) {
      delete doc.pending[keyVersion];
    }
    await this.#writeDekDoc(doc);
    this.#dekCache.delete(keyVersion);
  }
```

Add this private resolver above the `createDek`/`unwrapDek` stubs region (near the KEK section):

```typescript
  /** Readable DEK entry (active or in-window pending), or null if absent/elapsed. No write. */
  async #resolveDek(keyVersion: number): Promise<DekEntry | null> {
    const doc = await this.#readDekDoc();
    const active = doc.active[keyVersion];
    if (active) return active;
    const pending = doc.pending[keyVersion];
    if (pending && !this.#elapsed(pending.recoveryWindowUntil)) return pending;
    return null;
  }
```

- [ ] **Step 4: Run to verify the DEK tests pass**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: PASS (KEK + DEK blocks).

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/crypto/railway-secret-key-store.ts test/crypto/railway-secret-key-store.test.ts
git commit -m "feat(crypto): RailwaySecretKeyStore DEK create/unwrap/destroy"
```

---

## Task 5: `RailwaySecretKeyStore` — recoverability + shred proof

**Files:**
- Modify: `src/crypto/railway-secret-key-store.ts` (implement `recoverability`)
- Test: `test/crypto/railway-secret-key-store.test.ts` (add a recoverability describe block)

- [ ] **Step 1: Add the failing recoverability tests**

Append to `test/crypto/railway-secret-key-store.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: FAIL — `not implemented` for recoverability.

- [ ] **Step 3: Implement `recoverability`**

Replace the `recoverability` stub in `src/crypto/railway-secret-key-store.ts` with:

```typescript
  async recoverability(query: RecoverabilityQuery): Promise<Recoverability> {
    if (query.type === 'kek') {
      const doc = await this.#readKekDoc();
      if (doc.active[query.kekVersion]) return { recoverable: true, recoveryWindowUntil: null };
      const pending = doc.pending[query.kekVersion];
      if (pending && !this.#elapsed(pending.recoveryWindowUntil)) {
        return { recoverable: true, recoveryWindowUntil: this.#windowUntil(pending.recoveryWindowUntil) };
      }
      return { recoverable: false, recoveryWindowUntil: null };
    }

    const entry = await this.#resolveDek(query.keyVersion);
    if (!entry) return { recoverable: false, recoveryWindowUntil: null };
    // Honest: a DEK is only recoverable while its KEK is too.
    const kekRec = await this.recoverability({ type: 'kek', kekVersion: entry.kekVersion });
    if (!kekRec.recoverable) return { recoverable: false, recoveryWindowUntil: null };
    return { recoverable: true, recoveryWindowUntil: this.#windowUntil(entry.recoveryWindowUntil) };
  }
```

- [ ] **Step 4: Run the full store suite**

Run: `npx vitest run test/crypto/railway-secret-key-store.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/crypto/railway-secret-key-store.ts test/crypto/railway-secret-key-store.test.ts
git commit -m "feat(crypto): RailwaySecretKeyStore recoverability + crypto-shred proof"
```

---

## Task 6: Config — the `railway` provider and its secrets

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `.env.example`
- Test: `test/config/*` — add a focused case (see Step 1)

- [ ] **Step 1: Write a failing config test**

Create `test/config/railway-key-provider.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

const base = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
};

describe('config — railway key provider', () => {
  it('accepts CRYPTO_KEY_PROVIDER=railway', () => {
    const parsed = configSchema.parse({ ...base, CRYPTO_KEY_PROVIDER: 'railway' });
    expect(parsed.CRYPTO_KEY_PROVIDER).toBe('railway');
  });

  it('defaults the two key-material secret names', () => {
    const parsed = configSchema.parse({ ...base, CRYPTO_KEY_PROVIDER: 'railway' });
    expect(parsed.CRYPTO_KEK_SECRET_NAME).toBe('CRYPTO_KEK_MATERIAL');
    expect(parsed.CRYPTO_WRAPPED_DEK_SECRET_NAME).toBe('CRYPTO_WRAPPED_DEK_MATERIAL');
  });
});
```

Note: confirm the exported schema name in `src/config/schema.ts` (it may be `configSchema` or `configObjectSchema` per the retention-state memory). Import whichever the file exports; adjust the import above to match.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/config/railway-key-provider.test.ts`
Expected: FAIL — `'railway'` not in enum.

- [ ] **Step 3: Extend the config schema**

In `src/config/schema.ts`:
- Change the provider enum (line ~97) to include `railway`:
  ```typescript
  CRYPTO_KEY_PROVIDER: z.enum(['local', 'keystore', 'railway', 'kms']).default('local'),
  ```
- Immediately after the existing `CRYPTO_KEY_STORE_DIR` / `CRYPTO_KEK_VERSION` block (~line 118), add the Railway-store settings:
  ```typescript
  // --- Railway-secret key store (production-capable; see ADR 0008) ---
  /** Secret name holding the KEK document. Injected into services at boot; mutated by the CLIs. */
  CRYPTO_KEK_SECRET_NAME: z.string().min(1).default('CRYPTO_KEK_MATERIAL'),
  /** Secret name holding the wrapped-DEK document. */
  CRYPTO_WRAPPED_DEK_SECRET_NAME: z.string().min(1).default('CRYPTO_WRAPPED_DEK_MATERIAL'),
  /** KEK document value (JSON), injected at boot on services. Consumer validates presence. */
  CRYPTO_KEK_MATERIAL: z.string().optional(),
  /** Wrapped-DEK document value (JSON), injected at boot on services. */
  CRYPTO_WRAPPED_DEK_MATERIAL: z.string().optional(),
  /** Railway API token — CLIs only, to read/write the two secrets and trigger a redeploy. */
  RAILWAY_API_TOKEN: z.string().optional(),
  /** Railway environment + service the CLIs mutate secrets on. CLIs validate presence. */
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  RAILWAY_SERVICE_ID: z.string().optional(),
  ```

- [ ] **Step 4: Update `.env.example`**

Add a block (keep schema and example in lockstep, per CLAUDE.md §5):

```dotenv
# Key store (production): back the KeyStore with Railway Secrets — ADR 0008
CRYPTO_KEY_PROVIDER=railway
CRYPTO_KEK_SECRET_NAME=CRYPTO_KEK_MATERIAL
CRYPTO_WRAPPED_DEK_SECRET_NAME=CRYPTO_WRAPPED_DEK_MATERIAL
# The two documents below are injected as Railway secrets; do NOT commit real values.
CRYPTO_KEK_MATERIAL=
CRYPTO_WRAPPED_DEK_MATERIAL=
# CLIs only (bootstrap/rotate/revoke): Railway API access to mutate the two secrets + redeploy.
RAILWAY_API_TOKEN=
RAILWAY_ENVIRONMENT_ID=
RAILWAY_SERVICE_ID=
```

- [ ] **Step 5: Run the config test + typecheck**

Run: `npx vitest run test/config/railway-key-provider.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts .env.example test/config/railway-key-provider.test.ts
git commit -m "feat(config): railway key provider + key-material/Railway-API settings"
```

---

## Task 7: Wire the `railway` provider into the key-provider factory

**Files:**
- Modify: `src/crypto/key-provider.ts` (`keyStoreFromConfig`, `buildKeyProvider`, add `isKeyStoreProvider`)
- Modify: `src/crypto/index.ts` (exports)
- Test: `test/crypto/key-provider-builder.test.ts` (add railway cases)

- [ ] **Step 1: Add failing builder tests**

Append to `test/crypto/key-provider-builder.test.ts` (match its existing imports/harness; it builds a `Config` object — reuse its helper):

```typescript
import { RailwaySecretKeyStore } from '../../src/crypto/railway-secret-key-store.js';
import { isKeyStoreProvider, keyStoreFromConfig } from '../../src/crypto/key-provider.js';

describe('keyStoreFromConfig — railway', () => {
  it('builds a RailwaySecretKeyStore for provider=railway (production allowed)', () => {
    const config = makeConfig({
      NODE_ENV: 'production',
      CRYPTO_KEY_PROVIDER: 'railway',
      CRYPTO_KEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
      CRYPTO_WRAPPED_DEK_MATERIAL: JSON.stringify({ active: {}, pending: {} }),
    });
    const store = keyStoreFromConfig(config);
    expect(store).toBeInstanceOf(RailwaySecretKeyStore);
  });

  it('isKeyStoreProvider is true for keystore and railway, false for local/kms', () => {
    expect(isKeyStoreProvider('keystore')).toBe(true);
    expect(isKeyStoreProvider('railway')).toBe(true);
    expect(isKeyStoreProvider('local')).toBe(false);
    expect(isKeyStoreProvider('kms')).toBe(false);
  });
});
```

Note: `makeConfig` — reuse the existing test helper in this file (or `test/_helpers` / `test/config` builder). If none exists, build the config via `configSchema.parse({...})`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crypto/key-provider-builder.test.ts`
Expected: FAIL — `isKeyStoreProvider` / railway branch missing.

- [ ] **Step 3: Implement the railway branch + helper**

In `src/crypto/key-provider.ts`:

Add imports at the top:
```typescript
import { RailwaySecretKeyStore } from './railway-secret-key-store.js';
import { EnvSecretBackend } from './secret-backend.js';
```

Add an exported helper after `NON_LOCAL_ENVS`:
```typescript
/** True for providers backed by the external {@link KeyStore} seam (keystore or railway). */
export function isKeyStoreProvider(provider: Config['CRYPTO_KEY_PROVIDER']): boolean {
  return provider === 'keystore' || provider === 'railway';
}
```

In `keyStoreFromConfig`, add a `railway` branch BEFORE the existing production refusal (so railway is allowed in production; keystore is still refused there):
```typescript
export function keyStoreFromConfig(config: Config): KeyStore {
  if (config.CRYPTO_KEY_PROVIDER === 'railway') {
    return new RailwaySecretKeyStore({
      backend: new EnvSecretBackend({
        [config.CRYPTO_KEK_SECRET_NAME]: config.CRYPTO_KEK_MATERIAL,
        [config.CRYPTO_WRAPPED_DEK_SECRET_NAME]: config.CRYPTO_WRAPPED_DEK_MATERIAL,
      }),
      kekSecretName: config.CRYPTO_KEK_SECRET_NAME,
      dekSecretName: config.CRYPTO_WRAPPED_DEK_SECRET_NAME,
      recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
    });
  }
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'CRYPTO_KEY_PROVIDER=keystore uses LocalFileKeyStore, forbidden in production; use CRYPTO_KEY_PROVIDER=railway (ADR 0008)',
    );
  }
  if (!config.CRYPTO_KEY_STORE_DIR) {
    throw new Error('CRYPTO_KEY_STORE_DIR is required when CRYPTO_KEY_PROVIDER=keystore');
  }
  return new LocalFileKeyStore({
    dir: config.CRYPTO_KEY_STORE_DIR,
    recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
  });
}
```

In `buildKeyProvider`, change the `keystore`-only branch to cover both keystore-family providers:
```typescript
  if (isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
    const keyStore = deps.keyStore ?? keyStoreFromConfig(config);
    return new KeyStoreProvider({
      keyStore,
      loadActiveKeyVersion: () => getActiveKeyVersion(pool),
    });
  }
```

- [ ] **Step 4: Export new symbols from `src/crypto/index.ts`**

Add:
```typescript
export { RailwaySecretKeyStore } from './railway-secret-key-store.js';
export {
  EnvSecretBackend,
  InMemorySecretBackend,
  ReadOnlySecretBackendError,
  type SecretBackend,
} from './secret-backend.js';
export { isKeyStoreProvider } from './key-provider.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/crypto/key-provider-builder.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/crypto/key-provider.ts src/crypto/index.ts test/crypto/key-provider-builder.test.ts
git commit -m "feat(crypto): wire railway provider into key-provider factory"
```

---

## Task 8: Flip the launch gate to accept `railway`

**Files:**
- Modify: `src/key-lifecycle/launch-gate.ts`
- Modify: `src/key-lifecycle/readiness.ts`
- Test: `test/key-lifecycle/launch-gate.test.ts`

- [ ] **Step 1: Add failing launch-gate tests**

Add to `test/key-lifecycle/launch-gate.test.ts` (reuse its existing pool/keyStore/config harness):

```typescript
it('passes in production when the provider is railway (no destroyed drift)', async () => {
  const result = await checkLaunchGate({
    pool,
    keyStore,
    config: makeConfig({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'railway' }),
  });
  expect(result.failures).not.toContain(
    expect.stringContaining('requires a verified'),
  );
  expect(result.ok).toBe(true);
});

it('fails in production when the provider is keystore', async () => {
  const result = await checkLaunchGate({
    pool,
    keyStore,
    config: makeConfig({ NODE_ENV: 'production', CRYPTO_KEY_PROVIDER: 'keystore' }),
  });
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toMatch(/production requires/);
});
```

- [ ] **Step 2: Run to verify the railway case fails**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/key-lifecycle/launch-gate.test.ts`
Expected: FAIL — production+railway currently produces a failure.

- [ ] **Step 3: Update the gate condition**

In `src/key-lifecycle/launch-gate.ts`, change the production check (line ~32) to accept railway or a verified KMS:

```typescript
  // 3. Production must use a production-grade key store: Railway Secrets (ADR 0008) or a verified KMS.
  const productionOk =
    deps.config.CRYPTO_KEY_PROVIDER === 'railway' || deps.config.CRYPTO_KEY_PROVIDER === 'kms';
  if (deps.config.NODE_ENV === 'production' && !productionOk) {
    failures.push(
      `production requires the Railway-secret key store or a verified external KMS (CRYPTO_KEY_PROVIDER=${deps.config.CRYPTO_KEY_PROVIDER}); local/keystore are dev/staging only — ADR 0008`,
    );
  }
```

Also update the JSDoc bullet 3 above the function to read: "production is running on neither the Railway-secret key store nor a verified external KMS."

- [ ] **Step 4: Update readiness**

In `src/key-lifecycle/readiness.ts` (~line 45), the keystore-boot guard currently keys on `CRYPTO_KEY_PROVIDER === 'keystore'`. Change it to the shared helper so railway is included:

```typescript
import { buildKeyProvider, isKeyStoreProvider } from '../crypto/index.js';
// ...
  if (isKeyStoreProvider(deps.config.CRYPTO_KEY_PROVIDER)) {
    await assertKeystoreReady(deps.pool);
  }
```

(Adjust to the exact local function/name in that file; the change is: `=== 'keystore'` → `isKeyStoreProvider(...)`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/key-lifecycle/launch-gate.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/key-lifecycle/launch-gate.ts src/key-lifecycle/readiness.ts test/key-lifecycle/launch-gate.test.ts
git commit -m "feat(key-lifecycle): launch gate + readiness accept railway provider"
```

---

## Task 9: `RailwayApiSecretBackend` + CLI wiring

**Files:**
- Create: `src/crypto/railway-api-secret-backend.ts`
- Modify: `src/scripts/bootstrap-key.ts`, `rotate-kek.ts`, `rotate-key.ts`, `revoke-key.ts`, `confirm-destruction.ts`
- Test: `test/crypto/railway-api-secret-backend.test.ts`

- [ ] **Step 1: Write the failing adapter test (mocked fetch)**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { RailwayApiSecretBackend } from '../../src/crypto/railway-api-secret-backend.js';

function fetchReturning(json: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
  } as unknown as Response);
}

const opts = {
  token: 't',
  environmentId: 'env-1',
  serviceId: 'svc-1',
};

describe('RailwayApiSecretBackend', () => {
  it('read returns the decoded variable value', async () => {
    const fetchMock = fetchReturning({ data: { variables: { CRYPTO_KEK_MATERIAL: '{"active":{}}' } } });
    const backend = new RailwayApiSecretBackend({ ...opts, fetch: fetchMock });
    expect(await backend.read('CRYPTO_KEK_MATERIAL')).toBe('{"active":{}}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('read returns undefined for an absent variable', async () => {
    const backend = new RailwayApiSecretBackend({ ...opts, fetch: fetchReturning({ data: { variables: {} }) });
    expect(await backend.read('NOPE')).toBeUndefined();
  });

  it('write issues a variableUpsert mutation and never logs the value', async () => {
    const fetchMock = fetchReturning({ data: { variableUpsert: true } });
    const backend = new RailwayApiSecretBackend({ ...opts, fetch: fetchMock });
    await backend.write('CRYPTO_KEK_MATERIAL', '{"active":{"kek-1":{"bytes":"x"}}}');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toMatch(/variableUpsert/);
    expect(body.variables.value).toBe('{"active":{"kek-1":{"bytes":"x"}}}');
  });

  it('throws on a GraphQL error response', async () => {
    const backend = new RailwayApiSecretBackend({
      ...opts,
      fetch: fetchReturning({ errors: [{ message: 'nope' }] }),
    });
    await expect(backend.read('X')).rejects.toThrow(/Railway API/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crypto/railway-api-secret-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/crypto/railway-api-secret-backend.ts`**

```typescript
import type { SecretBackend } from './secret-backend.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RailwayApiSecretBackendOptions {
  token: string;
  environmentId: string;
  serviceId: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Railway GraphQL endpoint; defaults to the public API. */
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://backboard.railway.app/graphql/v2';

/**
 * Read+write {@link SecretBackend} over Railway's GraphQL API. Used by the key-lifecycle CLIs only
 * (bootstrap/rotate/revoke/confirm-destruction) — a running service uses the read-only
 * EnvSecretBackend. Never logs variable values (key material). After a CLI mutates secrets, the
 * operator must redeploy the encrypting services so they pick up the new material (see ADR 0008).
 */
export class RailwayApiSecretBackend implements SecretBackend {
  readonly #token: string;
  readonly #environmentId: string;
  readonly #serviceId: string;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;

  constructor(opts: RailwayApiSecretBackendOptions) {
    this.#token = opts.token;
    this.#environmentId = opts.environmentId;
    this.#serviceId = opts.serviceId;
    this.#fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.#endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  }

  async #gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Railway API HTTP ${String(res.status)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Railway API error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new Error('Railway API: empty response');
    return json.data;
  }

  async read(name: string): Promise<string | undefined> {
    const data = await this.#gql<{ variables: Record<string, string> }>(
      `query($environmentId: String!, $serviceId: String!) {
         variables(environmentId: $environmentId, serviceId: $serviceId)
       }`,
      { environmentId: this.#environmentId, serviceId: this.#serviceId },
    );
    return data.variables[name];
  }

  async write(name: string, value: string): Promise<void> {
    await this.#gql<{ variableUpsert: boolean }>(
      `mutation($environmentId: String!, $serviceId: String!, $name: String!, $value: String!) {
         variableUpsert(input: {
           environmentId: $environmentId, serviceId: $serviceId, name: $name, value: $value
         })
       }`,
      { environmentId: this.#environmentId, serviceId: this.#serviceId, name, value },
    );
  }
}
```

Note: the exact Railway GraphQL field/argument names (`variables`, `variableUpsert`, whether a `projectId` is also required) must be re-verified against Railway's current public API schema at build time — treat the shapes above as the intended contract, adjust field names to the live schema, and keep the tests asserting behavior (a `variableUpsert`-style mutation is issued; values are never logged).

- [ ] **Step 4: Run the adapter test**

Run: `npx vitest run test/crypto/railway-api-secret-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a CLI helper and wire the five CLIs**

Add to `src/crypto/key-provider.ts` a CLI-only builder that returns a write-capable store:

```typescript
import { RailwayApiSecretBackend } from './railway-api-secret-backend.js';

/**
 * Build a write-capable {@link KeyStore} for the key-lifecycle CLIs. For `railway` this talks to the
 * Railway API (needs RAILWAY_API_TOKEN + env/service ids); for `keystore` it reuses the file store.
 */
export function keyStoreForCli(config: Config): KeyStore {
  if (config.CRYPTO_KEY_PROVIDER === 'railway') {
    if (!config.RAILWAY_API_TOKEN || !config.RAILWAY_ENVIRONMENT_ID || !config.RAILWAY_SERVICE_ID) {
      throw new Error(
        'railway key CLIs require RAILWAY_API_TOKEN, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID',
      );
    }
    return new RailwaySecretKeyStore({
      backend: new RailwayApiSecretBackend({
        token: config.RAILWAY_API_TOKEN,
        environmentId: config.RAILWAY_ENVIRONMENT_ID,
        serviceId: config.RAILWAY_SERVICE_ID,
      }),
      kekSecretName: config.CRYPTO_KEK_SECRET_NAME,
      dekSecretName: config.CRYPTO_WRAPPED_DEK_SECRET_NAME,
      recoveryWindowDays: config.KEY_STORE_RECOVERY_WINDOW_DAYS,
    });
  }
  return keyStoreFromConfig(config);
}
```

Export it from `src/crypto/index.ts`:
```typescript
export { keyStoreForCli } from './key-provider.js';
```

In each of the five CLIs, make two edits:
1. Replace the provider guard `if (config.CRYPTO_KEY_PROVIDER !== 'keystore') { throw new Error('<cli> requires CRYPTO_KEY_PROVIDER=keystore'); }` with:
   ```typescript
   if (!isKeyStoreProvider(config.CRYPTO_KEY_PROVIDER)) {
     throw new Error('<cli> requires CRYPTO_KEY_PROVIDER=keystore or railway');
   }
   ```
   (import `isKeyStoreProvider` from `'../crypto/index.js'`.)
2. Replace `const keyStore = keyStoreFromConfig(config);` with `const keyStore = keyStoreForCli(config);` (import `keyStoreForCli`). For `confirm-destruction.ts` and any CLI that builds the store differently, make the equivalent swap so a `railway` run gets the write-capable API backend.

The affected lines are: `bootstrap-key.ts:30-31,41`, `rotate-kek.ts:29-30`, `rotate-key.ts:40-41`, `revoke-key.ts:33-34`, `confirm-destruction.ts:22-23` (plus each file's `keyStoreFromConfig` call site).

- [ ] **Step 6: Full crypto + key-lifecycle suites + typecheck**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/crypto test/key-lifecycle test/config`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/crypto/railway-api-secret-backend.ts src/crypto/key-provider.ts src/crypto/index.ts src/scripts/bootstrap-key.ts src/scripts/rotate-kek.ts src/scripts/rotate-key.ts src/scripts/revoke-key.ts src/scripts/confirm-destruction.ts test/crypto/railway-api-secret-backend.test.ts
git commit -m "feat(crypto): Railway API secret backend + key CLIs accept railway"
```

---

## Task 10: Docs — ADR 0008, 8.2b downgrade, CLAUDE.md

**Files:**
- Create: `docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md`
- Modify: `docs/task-8-2b-production-kms.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write ADR 0008**

Create `docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md` with: Status (accepted, 2026-07-08); Context (simplify the client's footprint — no dedicated cloud KMS; the crypto-shred promise must survive); Decision (Move 1: `RailwaySecretKeyStore` over the existing `KeyStore` seam, KEK + wrapped DEKs in two Railway secrets, `railway` provider accepted in production, launch gate flipped; Move 2 is Plan 2 — the separate no-backup raw-store DB); Consequences (accepted trade-off vs. hardware KMS: no HSM isolation, key readable by Railway admins, audit = Railway secret history; justified by short raw retention + backup isolation; KMS remains a drop-in future upgrade via the same seam); and a pointer to the spec `docs/superpowers/specs/2026-07-08-railway-secret-keystore-and-raw-store-isolation-design.md`.

- [ ] **Step 2: Downgrade Task 8.2b**

At the top of `docs/task-8-2b-production-kms.md`, change the Status line from "OPEN — blocking follow-up to Task 8.2" to:

```markdown
Status: **OPTIONAL FUTURE UPGRADE (no longer a launch blocker).** Production key custody is now
provided by the Railway-secret key store (ADR 0008 / `CRYPTO_KEY_PROVIDER=railway`). A dedicated
external KMS remains a supported drop-in upgrade via the same `KeyStore` seam, but is not required
to go live. The launch gate now passes on `railway`.
```

Leave the rest as the KMS upgrade reference.

- [ ] **Step 3: Correct CLAUDE.md**

In `CLAUDE.md`, update the key-lifecycle paragraph that currently ends with "**Production live-processing is NOT unblocked**: the production KMS provider is the named blocking follow-up **Task 8.2b** ... `keystore` is refused in production, `kms` still throws, and the launch gate fails in production without a verified KMS." Replace with a sentence stating production key custody is the Railway-secret key store (`CRYPTO_KEY_PROVIDER=railway`, ADR 0008); `local`/`keystore` remain dev/staging only; a dedicated KMS (Task 8.2b) is an optional future upgrade via the same seam. (Keep it to the existing terse style.)

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md docs/task-8-2b-production-kms.md CLAUDE.md
git commit -m "docs: ADR 0008 railway key store; downgrade Task 8.2b to optional upgrade"
```

---

## Task 11: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test`
Expected: PASS (pre-existing green count + the new crypto/config/key-lifecycle tests). If onnxruntime-node install flakes, rerun once (known-transient, per project notes).

- [ ] **Step 4: Build + format check + audit**

Run: `npm run build && npm run format:check && npm audit --audit-level=high`
Expected: build succeeds; format clean; no high/critical advisories introduced.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin task/8.2c-railway-keystore-raw-isolation
gh pr create --base main --title "feat(crypto): Railway-secret key store (production key custody without KMS) — ADR 0008" --body "$(cat <<'EOF'
Implements Move 1 of the Railway-secret + raw-store-isolation design.

- New RailwaySecretKeyStore over the existing KeyStore seam (KEK + wrapped DEKs in two Railway secrets), mirroring LocalFileKeyStore's two-state recovery-windowed destruction.
- SecretBackend seam: in-memory (tests), read-only env (services), Railway GraphQL API (CLIs).
- CRYPTO_KEY_PROVIDER=railway accepted in production; launch gate + readiness updated.
- Task 8.2b (external KMS) downgraded to an optional future upgrade (ADR 0008).

Move 2 (separate no-backup raw-store DB) follows as a second PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed during authoring)

- **Spec coverage (Move 1):** RailwaySecretKeyStore (Tasks 3–5) ✓; two secrets for KEK + wrapped DEKs (Task 3 doc shapes) ✓; new `railway` provider accepted in production (Tasks 6–7) ✓; launch-gate flip (Task 8) ✓; recovery-windowed two-state destruction reused (Tasks 3–5) ✓; CLI-drives-secret-then-redeploy model (Task 9 + ADR note) ✓; crypto-shred proof test (Task 4) ✓; 8.2b downgrade + docs (Task 10) ✓; config/.env lockstep (Task 6) ✓. Move 2 (raw-store DB) is intentionally deferred to Plan 2.
- **Placeholders:** none — every code step carries full code; the two build-time verifications (exported config schema symbol name in Task 6; Railway GraphQL field names in Task 9) are called out explicitly with how to resolve them.
- **Type consistency:** `KeyStore` methods match `src/crypto/key-store.ts`; `SecretBackend.read/write` used consistently; `RailwaySecretKeyStoreOptions` fields (`kekSecretName`/`dekSecretName`/`recoveryWindowDays`/`clock`) are identical across store, `keyStoreFromConfig`, and `keyStoreForCli`; `isKeyStoreProvider` used identically in builder, readiness, and CLIs.
