# Railway Deploy Config + Migration Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Task 0.3 infrastructure — per-service Railway deploy config, a node-pg-migrate runner wired as the pre-deploy command, and a dependency-injected boot readiness check — with no business logic.

**Architecture:** Four thin service entrypoints (`webhook-receiver`, `worker`, `reconciliation-cron`, `retention-cron`) share one codebase. Each boots via `loadConfig()` → `assertDependenciesReady()` → log. The two long-running services then `await keepAlive()`; the crons exit. Store URLs (`DATABASE_URL`/`REDIS_URL`) are readiness-owned so a missing **or** unreachable store maps to `DATABASE_UNAVAILABLE`/`REDIS_UNAVAILABLE`, never `CONFIG_MISSING_OR_INVALID`. A forerunner error module (`FatalBootError` + `failBoot`) mirrors the config loader's taxonomy-aligned, flush-before-exit fatal path, to be absorbed by the Task 2.2 failure model.

**Tech Stack:** Node 22, TypeScript strict (`NodeNext`, `verbatimModuleSyntax`), ESM, zod, pino, `pg`, `ioredis`, `node-pg-migrate`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-railway-deploy-migration-runner-design.md`

---

## Toolchain gotchas (read once before starting)

- **ESM import specifiers use `.js`** even for `.ts` source (e.g. `import { loadConfig } from '../config/index.js'`). Match existing files.
- **`verbatimModuleSyntax` is on:** type-only imports must use `import type` (or inline `type`). Value+type mix like `import { pino, type DestinationStream } from 'pino'` is fine.
- **CJS interop under `NodeNext`:** import `pg` as a default then destructure — `import pg from 'pg'; const { Client } = pg;`. `ioredis` has a real default export: `import Redis from 'ioredis'`. `node-pg-migrate`'s default export is the callable runner: `import pgMigrate from 'node-pg-migrate'` (confirm it's callable when you wire the adapter in Task 5; the unit test injects a stub runner, so production wiring is a one-line adapter).
- **`exactOptionalPropertyTypes` is on:** never assign `undefined` to an optional property — build objects with conditional spreads (see `sanitizeConnectionContext`), the same style `src/config/index.ts` already uses.
- Run a single vitest file with: `npx vitest run test/<name>.test.ts`.

## File structure

**Create:**
- `src/boot/codes.ts` — taxonomy codes, `FatalBootError`, `sanitizeConnectionContext`, `failBoot`.
- `src/boot/logger.ts` — `createBootLogger()` on a synchronous destination.
- `src/boot/readiness.ts` — `assertDependenciesReady()` (DI Postgres/Redis probes).
- `src/boot/keepalive.ts` — signal-aware `keepAlive()`.
- `src/boot/migrate-runner.ts` — pure `runMigrations()` (DI runner).
- `src/scripts/migrate.ts` — thin CLI entry → compiles to `dist/scripts/migrate.js`.
- `src/services/webhook-receiver.ts`, `worker.ts`, `reconciliation-cron.ts`, `retention-cron.ts`.
- `migrations/.gitkeep`, `migrations/README.md`.
- `deploy/railway/{webhook-receiver,worker,reconciliation-cron,retention-cron}.json`, `deploy/railway/README.md`.
- `test/boot-codes.test.ts`, `test/readiness.test.ts`, `test/keepalive.test.ts`, `test/migrate.test.ts`.

**Modify:**
- `src/config/schema.ts` — `DATABASE_URL`/`REDIS_URL` optional; add two timeouts.
- `.env.example` — mirror the schema.
- `test/config.test.ts` — re-point the missing-var cases off `DATABASE_URL`.
- `package.json` — new deps + `db:migrate` / `db:migrate:down` scripts.

---

## Task 1: Config schema — store URLs readiness-owned, add timeouts

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `.env.example`
- Modify: `test/config.test.ts`
- Install: `pg`, `ioredis`, `node-pg-migrate`, `@types/pg`

- [ ] **Step 1: Install dependencies**

```bash
npm install pg ioredis node-pg-migrate
npm install --save-dev @types/pg
```

Expected: `package.json` gains the three runtime deps and one dev dep; `package-lock.json` updates.

- [ ] **Step 2: Update the failing config test first**

Because `DATABASE_URL` is becoming optional at the config layer, the existing tests that delete it must be re-pointed to a still-required var (`NODE_ENV`). Replace the first two `it(...)` blocks in `test/config.test.ts` with these:

```ts
  it('exits with the named-value error when a required variable is missing', () => {
    const env = validEnv();
    delete env.NODE_ENV;

    // Capture the exit and the emitted error instead of killing the test runner.
    const exit = vi.fn((_code: number) => undefined as never);
    const onError = vi.fn();

    loadConfig(env, { exit, onError });

    // It exits non-zero...
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    // ...and the error NAMES the missing variable with the stable code.
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0] as ConfigError;
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe(CONFIG_ERROR_CODE);
    expect(error.invalid).toContain('NODE_ENV');
    expect(error.message).toContain(CONFIG_ERROR_CODE);
    expect(error.message).toContain('NODE_ENV');
  });

  it('names every offending variable when several are missing or invalid', () => {
    const env = validEnv();
    delete env.NODE_ENV;
    env.LOG_LEVEL = 'bogus';

    const result = validateEnv(env);

    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows the type for the assertions below
    expect(result.error.invalid).toEqual(expect.arrayContaining(['NODE_ENV', 'LOG_LEVEL']));
    expect(result.error.message).toContain('NODE_ENV');
    expect(result.error.message).toContain('LOG_LEVEL');
  });
```

Also add a positive test that a missing `DATABASE_URL` is now **accepted** by config (readiness owns it). Append inside the `describe('config loader', ...)` block:

```ts
  it('accepts a missing DATABASE_URL — readiness owns store reachability', () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    const exit = vi.fn((_code: number) => undefined as never);
    const config = loadConfig(env, { exit });

    expect(exit).not.toHaveBeenCalled();
    expect(config.DATABASE_URL).toBeUndefined();
  });
```

- [ ] **Step 3: Run the config test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — the new "accepts a missing DATABASE_URL" test fails because the schema still requires `DATABASE_URL`.

- [ ] **Step 4: Update the schema**

In `src/config/schema.ts`, replace the `DATABASE_URL` line and add `REDIS_URL` + the two timeouts:

```ts
  /** Postgres connection string. Optional here: presence + reachability are owned
   * by the boot readiness check, which emits DATABASE_UNAVAILABLE rather than
   * CONFIG_MISSING_OR_INVALID so the store-specific code always surfaces. */
  DATABASE_URL: z.string().min(1).optional(),

  /** Redis connection string (BullMQ backend). Optional for the same reason as
   * DATABASE_URL — readiness owns it and emits REDIS_UNAVAILABLE. */
  REDIS_URL: z.string().min(1).optional(),

  /** Readiness: Postgres connect timeout (ms). Fail fast, never hang. */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** Readiness: Redis connect timeout (ms). Fail fast, never hang. */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
```

Place `REDIS_URL` and the timeouts after the existing `DATABASE_URL` entry, before `LOG_LEVEL`.

- [ ] **Step 5: Update `.env.example` in lockstep**

Replace the `DATABASE_URL` block and add the new vars so the file mirrors the schema:

```bash
# --- Required in every real deployment (validated by the readiness check, not the
#     config loader — a missing/unreachable store exits DATABASE_UNAVAILABLE /
#     REDIS_UNAVAILABLE, not CONFIG_MISSING_OR_INVALID) ---

# Postgres connection string (primary relational store).
DATABASE_URL=postgres://user:password@localhost:5432/gcp_call_insights

# Redis connection string (BullMQ queue backend).
REDIS_URL=redis://localhost:6379

# --- Optional (defaults shown) ---

# Readiness connect timeouts (ms) — fail fast rather than hang.
DB_CONNECT_TIMEOUT_MS=5000
REDIS_CONNECT_TIMEOUT_MS=5000
```

Keep `NODE_ENV` above `DATABASE_URL` and the existing `LOG_LEVEL`/`SERVICE_NAME`/`PORT` entries below.

- [ ] **Step 6: Run the config test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config/schema.ts .env.example test/config.test.ts
git commit -m "feat(0.3): store URLs readiness-owned; add REDIS_URL + readiness timeouts"
```

---

## Task 2: Boot error module + synchronous boot logger

**Files:**
- Create: `src/boot/codes.ts`
- Create: `src/boot/logger.ts`
- Test: `test/boot-codes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/boot-codes.test.ts`:

```ts
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_UNAVAILABLE,
  FatalBootError,
  failBoot,
  sanitizeConnectionContext,
} from '../src/boot/codes.js';

/** A fake logger that records fatal + flush call order. */
function fakeLogger(order: string[]): Logger {
  return {
    fatal: vi.fn(() => order.push('fatal')),
    flush: vi.fn(() => order.push('flush')),
  } as unknown as Logger;
}

describe('sanitizeConnectionContext', () => {
  it('keeps host/port/database but NEVER the password', () => {
    const ctx = sanitizeConnectionContext('postgres://user:supersecret@db.internal:5432/appdb');
    expect(ctx).toEqual({ host: 'db.internal', port: '5432', database: 'appdb' });
    expect(JSON.stringify(ctx)).not.toContain('supersecret');
    expect(JSON.stringify(ctx)).not.toContain('user');
  });

  it('returns an empty object for an absent or unparseable URL', () => {
    expect(sanitizeConnectionContext(undefined)).toEqual({});
    expect(sanitizeConnectionContext('not a url')).toEqual({});
  });
});

describe('failBoot', () => {
  it('logs the fatal line, flushes, THEN exits non-zero — in that order', () => {
    const order: string[] = [];
    const logger = fakeLogger(order);
    const exit = vi.fn((_code: number) => {
      order.push('exit');
      return undefined as never;
    });

    const err = new FatalBootError(DATABASE_UNAVAILABLE, 'DATABASE_UNAVAILABLE: down', {
      host: 'db.internal',
    });
    failBoot(logger, err, { exit });

    expect(logger.fatal).toHaveBeenCalledWith(
      { error_code: DATABASE_UNAVAILABLE, context: { host: 'db.internal' } },
      'DATABASE_UNAVAILABLE: down',
    );
    expect(exit).toHaveBeenCalledWith(1);
    // Flush must happen before exit or the buffered line can be lost.
    expect(order).toEqual(['fatal', 'flush', 'exit']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/boot-codes.test.ts`
Expected: FAIL — `../src/boot/codes.js` does not exist.

- [ ] **Step 3: Implement `src/boot/codes.ts`**

```ts
import type { Logger } from 'pino';

/**
 * Forerunner of the Task 2.2 failure model. These three boot-time codes are
 * members of the build-plan §4 root-cause taxonomy; this module ships them ahead
 * of the shared model exactly as the config loader ships CONFIG_MISSING_OR_INVALID.
 * FOLD INTO the Task 2.2 failure-model modules when they land.
 */
export const DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE' as const;
export const REDIS_UNAVAILABLE = 'REDIS_UNAVAILABLE' as const;
export const MIGRATION_FAILED = 'MIGRATION_FAILED' as const;

export type BootErrorCode =
  | typeof DATABASE_UNAVAILABLE
  | typeof REDIS_UNAVAILABLE
  | typeof MIGRATION_FAILED;

/** Sanitized connection context: host/port/database only. NEVER credentials. */
export interface ConnectionContext {
  host?: string;
  port?: string;
  database?: string;
  /** Set when the failure is a missing environment variable. */
  missing?: string;
}

/**
 * Derive sanitized context from a connection URL. Returns host/port/database only —
 * never userinfo (which holds the password). Empty object if absent/unparseable.
 */
export function sanitizeConnectionContext(url: string | undefined): ConnectionContext {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    return {
      ...(parsed.hostname ? { host: parsed.hostname } : {}),
      ...(parsed.port ? { port: parsed.port } : {}),
      ...(database ? { database } : {}),
    };
  } catch {
    return {};
  }
}

/** A fatal, un-retryable boot failure carrying a stable code and sanitized context. */
export class FatalBootError extends Error {
  readonly code: BootErrorCode;
  readonly context: ConnectionContext;

  constructor(code: BootErrorCode, message: string, context: ConnectionContext = {}) {
    super(message);
    this.name = 'FatalBootError';
    this.code = code;
    this.context = context;
  }
}

export interface FailBootDeps {
  /** Exit hook. Injectable so tests assert the exit without killing the runner. */
  exit?: (code: number) => never;
}

/**
 * Emit exactly one structured fatal line, FLUSH, then exit non-zero. The flush is
 * load-bearing: pino's default destination buffers, so a bare process.exit can drop
 * the line — the opposite of "exits loudly". Pair with {@link createBootLogger},
 * which uses a synchronous destination as the primary guarantee.
 */
export function failBoot(logger: Logger, error: FatalBootError, deps: FailBootDeps = {}): never {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  logger.fatal({ error_code: error.code, context: error.context }, error.message);
  logger.flush();
  return exit(1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/boot-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/boot/logger.ts`**

```ts
import { pino, type Logger } from 'pino';
import { createRootLogger, type RootLoggerOptions } from '../logging/logger.js';

/**
 * Root logger for the boot path, built on a SYNCHRONOUS destination so a fatal line
 * reaches fd 1 before {@link failBoot} calls process.exit. pino's default buffered
 * (sonic-boom) destination can otherwise drop the last line on exit.
 */
export function createBootLogger(options: Omit<RootLoggerOptions, 'destination'> = {}): Logger {
  return createRootLogger({ ...options, destination: pino.destination({ sync: true }) });
}
```

- [ ] **Step 6: Typecheck the new modules**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/boot/codes.ts src/boot/logger.ts test/boot-codes.test.ts
git commit -m "feat(0.3): boot error taxonomy forerunner + synchronous boot logger"
```

---

## Task 3: Boot readiness check

**Files:**
- Create: `src/boot/readiness.ts`
- Test: `test/readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/readiness.test.ts`:

```ts
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config/schema.js';
import { assertDependenciesReady, type PgProbe, type RedisProbe } from '../src/boot/readiness.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    DB_CONNECT_TIMEOUT_MS: 5000,
    REDIS_CONNECT_TIMEOUT_MS: 5000,
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'test',
    PORT: 8080,
    ...overrides,
  } as Config;
}

const silentLogger = { fatal: vi.fn(), flush: vi.fn() } as unknown as Logger;

function okPg(): PgProbe {
  return { connect: vi.fn(async () => {}), query: vi.fn(async () => {}), end: vi.fn(async () => {}) };
}
function okRedis(): RedisProbe {
  return { ping: vi.fn(async () => 'PONG'), quit: vi.fn(async () => 'OK') };
}

describe('assertDependenciesReady', () => {
  it('does not exit when Postgres and Redis are both reachable', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    await assertDependenciesReady(baseConfig(), silentLogger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits DATABASE_UNAVAILABLE when DATABASE_URL is missing', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    await assertDependenciesReady(baseConfig({ DATABASE_URL: undefined }), logger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'DATABASE_UNAVAILABLE' });
  });

  it('exits DATABASE_UNAVAILABLE when Postgres connect fails', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    const failingPg: PgProbe = {
      connect: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      query: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    };
    await assertDependenciesReady(baseConfig(), logger, {
      createPg: () => failingPg,
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'DATABASE_UNAVAILABLE' });
  });

  it('exits REDIS_UNAVAILABLE when REDIS_URL is missing (worker QA)', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    await assertDependenciesReady(baseConfig({ REDIS_URL: undefined }), logger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'REDIS_UNAVAILABLE' });
  });

  it('exits REDIS_UNAVAILABLE when Redis ping fails', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    const failingRedis: RedisProbe = {
      ping: vi.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      }),
      quit: vi.fn(async () => 'OK'),
    };
    await assertDependenciesReady(baseConfig(), logger, {
      createPg: () => okPg(),
      createRedis: () => failingRedis,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'REDIS_UNAVAILABLE' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/readiness.test.ts`
Expected: FAIL — `../src/boot/readiness.js` does not exist.

- [ ] **Step 3: Implement `src/boot/readiness.ts`**

```ts
import type { Logger } from 'pino';
import pg from 'pg';
import Redis from 'ioredis';
import type { Config } from '../config/schema.js';
import {
  DATABASE_UNAVAILABLE,
  REDIS_UNAVAILABLE,
  FatalBootError,
  failBoot,
  sanitizeConnectionContext,
} from './codes.js';

/** Minimal Postgres surface the check needs — satisfied by pg.Client. */
export interface PgProbe {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Minimal Redis surface the check needs — satisfied by ioredis. */
export interface RedisProbe {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export interface ReadinessDeps {
  createPg?: (url: string, connectTimeoutMs: number) => PgProbe;
  createRedis?: (url: string, connectTimeoutMs: number) => RedisProbe;
  exit?: (code: number) => never;
}

function defaultCreatePg(url: string, connectTimeoutMs: number): PgProbe {
  const { Client } = pg;
  return new Client({ connectionString: url, connectionTimeoutMillis: connectTimeoutMs });
}

function defaultCreateRedis(url: string, connectTimeoutMs: number): RedisProbe {
  // Fail fast, never hang: give up after one try instead of reconnecting forever.
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

async function checkPostgres(config: Config, deps: ReadinessDeps): Promise<void> {
  if (!config.DATABASE_URL) {
    throw new FatalBootError(DATABASE_UNAVAILABLE, `${DATABASE_UNAVAILABLE}: DATABASE_URL is not set`, {
      missing: 'DATABASE_URL',
    });
  }
  const create = deps.createPg ?? defaultCreatePg;
  const client = create(config.DATABASE_URL, config.DB_CONNECT_TIMEOUT_MS);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (cause) {
    throw new FatalBootError(
      DATABASE_UNAVAILABLE,
      `${DATABASE_UNAVAILABLE}: ${(cause as Error).message}`,
      sanitizeConnectionContext(config.DATABASE_URL),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRedis(config: Config, deps: ReadinessDeps): Promise<void> {
  if (!config.REDIS_URL) {
    throw new FatalBootError(REDIS_UNAVAILABLE, `${REDIS_UNAVAILABLE}: REDIS_URL is not set`, {
      missing: 'REDIS_URL',
    });
  }
  const create = deps.createRedis ?? defaultCreateRedis;
  const client = create(config.REDIS_URL, config.REDIS_CONNECT_TIMEOUT_MS);
  try {
    await client.ping();
  } catch (cause) {
    throw new FatalBootError(
      REDIS_UNAVAILABLE,
      `${REDIS_UNAVAILABLE}: ${(cause as Error).message}`,
      sanitizeConnectionContext(config.REDIS_URL),
    );
  } finally {
    await client.quit().catch(() => {});
  }
}

/**
 * Confirm Postgres and Redis are reachable at boot. On any failure — missing URL or
 * unreachable store — emit the store-specific code via {@link failBoot} and exit
 * non-zero. Postgres is checked first, then Redis. Clients and the exit hook are
 * injectable so tests run with no live servers.
 */
export async function assertDependenciesReady(
  config: Config,
  logger: Logger,
  deps: ReadinessDeps = {},
): Promise<void> {
  try {
    await checkPostgres(config, deps);
    await checkRedis(config, deps);
  } catch (err) {
    if (err instanceof FatalBootError) {
      failBoot(logger, err, { exit: deps.exit });
      return;
    }
    throw err;
  }
}
```

> Note: `failBoot` returns `never`, but in tests the injected `exit` returns rather than terminating, so the explicit `return` after it keeps control flow well-typed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/readiness.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add src/boot/readiness.ts test/readiness.test.ts
git commit -m "feat(0.3): boot readiness check for Postgres and Redis"
```

---

## Task 4: Signal-aware keepAlive

**Files:**
- Create: `src/boot/keepalive.ts`
- Test: `test/keepalive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/keepalive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keepAlive } from '../src/boot/keepalive.js';

describe('keepAlive', () => {
  it('stays pending until a shutdown signal, then resolves', async () => {
    let fire: () => void = () => {};
    const promise = keepAlive({ onShutdown: (handler) => (fire = handler) });

    let resolved = false;
    void promise.then(() => (resolved = true));

    // Give any queued microtasks a chance to run; it must still be pending.
    await Promise.resolve();
    expect(resolved).toBe(false);

    fire();
    await promise;
    expect(resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/keepalive.test.ts`
Expected: FAIL — `../src/boot/keepalive.js` does not exist.

- [ ] **Step 3: Implement `src/boot/keepalive.ts`**

```ts
export interface KeepAliveDeps {
  /** Register a shutdown handler. Injectable so tests drive it without real signals. */
  onShutdown?: (handler: () => void) => void;
}

/**
 * Hold the process open until a shutdown signal arrives, then resolve so the caller
 * can exit gracefully. No busy loop — it parks on signal handlers. Long-running
 * services (webhook-receiver, worker) await this after boot until real work lands;
 * crons never call it.
 */
export function keepAlive(deps: KeepAliveDeps = {}): Promise<void> {
  return new Promise((resolve) => {
    const onShutdown =
      deps.onShutdown ??
      ((handler: () => void): void => {
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
      });
    onShutdown(() => resolve());
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/keepalive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boot/keepalive.ts test/keepalive.test.ts
git commit -m "feat(0.3): signal-aware keepAlive for long-running services"
```

---

## Task 5: Migration runner (pure logic + CLI entry)

**Files:**
- Create: `src/boot/migrate-runner.ts`
- Create: `src/scripts/migrate.ts`
- Modify: `package.json` (scripts)
- Test: `test/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/migrate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/boot/migrate-runner.js';
import { FatalBootError } from '../src/boot/codes.js';

describe('runMigrations', () => {
  it('invokes the runner with advisoryLockMode "wait" and count Infinity on up', async () => {
    const runner = vi.fn(async () => []);
    await runMigrations('up', {
      runner,
      databaseUrl: 'postgres://user:pw@localhost:5432/db',
      migrationsDir: 'migrations',
    });
    expect(runner).toHaveBeenCalledTimes(1);
    const opts = runner.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.direction).toBe('up');
    expect(opts.count).toBe(Infinity);
    expect(opts.advisoryLockMode).toBe('wait');
    expect(opts.databaseUrl).toBe('postgres://user:pw@localhost:5432/db');
    expect(opts.dir).toBe('migrations');
  });

  it('passes count 1 on down', async () => {
    const runner = vi.fn(async () => []);
    await runMigrations('down', { runner, databaseUrl: 'postgres://x@localhost/db' });
    const opts = runner.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.direction).toBe('down');
    expect(opts.count).toBe(1);
  });

  it('throws MIGRATION_FAILED when the runner rejects', async () => {
    const runner = vi.fn(async () => {
      throw new Error('relation already exists');
    });
    await expect(
      runMigrations('up', { runner, databaseUrl: 'postgres://x@localhost/db' }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
  });

  it('throws MIGRATION_FAILED when DATABASE_URL is absent', async () => {
    const runner = vi.fn(async () => []);
    await expect(runMigrations('up', { runner, databaseUrl: undefined })).rejects.toBeInstanceOf(
      FatalBootError,
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/migrate.test.ts`
Expected: FAIL — `../src/boot/migrate-runner.js` does not exist.

- [ ] **Step 3: Implement `src/boot/migrate-runner.ts`**

```ts
import { MIGRATION_FAILED, FatalBootError, sanitizeConnectionContext } from './codes.js';

export type MigrationDirection = 'up' | 'down';

/** Option bag passed to node-pg-migrate's runner. Loosely typed so the unit test
 * can inject a stub without depending on the library's full RunnerOption type. */
export type MigrationRunner = (options: Record<string, unknown>) => Promise<unknown>;

export interface RunMigrationsDeps {
  runner?: MigrationRunner;
  databaseUrl?: string;
  migrationsDir?: string;
}

/** Directory holding migration files (relative to the process cwd = repo root). */
const DEFAULT_MIGRATIONS_DIR = 'migrations';

/**
 * Run migrations in one direction. `up` applies all pending; `down` rolls back one.
 * Sets advisoryLockMode 'wait' — node-pg-migrate defaults to 'fail', which would
 * error a concurrent pre-deploy rather than serialize it. Any failure (including a
 * missing DATABASE_URL) becomes a MIGRATION_FAILED FatalBootError.
 */
export async function runMigrations(
  direction: MigrationDirection,
  deps: RunMigrationsDeps = {},
): Promise<void> {
  const databaseUrl = deps.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new FatalBootError(MIGRATION_FAILED, `${MIGRATION_FAILED}: DATABASE_URL is not set`, {
      missing: 'DATABASE_URL',
    });
  }
  const runner = deps.runner ?? (await loadDefaultRunner());
  const dir = deps.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  try {
    await runner({
      databaseUrl,
      dir,
      direction,
      count: direction === 'up' ? Infinity : 1,
      migrationsTable: 'pgmigrations',
      advisoryLockMode: 'wait',
    });
  } catch (cause) {
    throw new FatalBootError(
      MIGRATION_FAILED,
      `${MIGRATION_FAILED}: ${(cause as Error).message}`,
      sanitizeConnectionContext(databaseUrl),
    );
  }
}

/** Adapter to node-pg-migrate's default runner export. Loaded lazily so the unit
 * test (which injects a stub) never imports the library. */
async function loadDefaultRunner(): Promise<MigrationRunner> {
  const mod = await import('node-pg-migrate');
  const runner = (mod.default ?? mod) as unknown as MigrationRunner;
  return runner;
}
```

> Implementation note: confirm `advisoryLockMode` is the exact option key in the installed `node-pg-migrate` version (per its docs it is). If the installed types name it differently, update both the adapter call and the test expectation to that key while keeping the `'wait'` intent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/migrate.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Implement the CLI entry `src/scripts/migrate.ts`**

```ts
import { createBootLogger } from '../boot/logger.js';
import { FatalBootError, failBoot } from '../boot/codes.js';
import { runMigrations, type MigrationDirection } from '../boot/migrate-runner.js';

/**
 * Railway pre-deploy entrypoint. `node dist/scripts/migrate.js up|down`. Runs
 * migrations; on failure emits MIGRATION_FAILED and exits non-zero so Railway fails
 * the deploy. Kept thin — the testable logic lives in migrate-runner.ts.
 */
async function main(): Promise<void> {
  const direction: MigrationDirection = process.argv[2] === 'down' ? 'down' : 'up';
  const logger = createBootLogger({ name: 'migrate' });
  try {
    await runMigrations(direction);
    logger.info({ direction }, 'migrations complete');
  } catch (err) {
    if (err instanceof FatalBootError) {
      failBoot(logger, err);
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`MIGRATION_FAILED: ${String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Add npm scripts**

In `package.json`, add to `"scripts"` (after `"start"`):

```json
    "db:migrate": "node dist/scripts/migrate.js up",
    "db:migrate:down": "node dist/scripts/migrate.js down",
```

- [ ] **Step 7: Verify build emits the compiled entry**

Run: `npm run build && ls dist/scripts/migrate.js`
Expected: `dist/scripts/migrate.js` exists (so `npm run db:migrate` resolves on a fresh Railway checkout after build).

- [ ] **Step 8: Commit**

```bash
git add src/boot/migrate-runner.ts src/scripts/migrate.ts test/migrate.test.ts package.json
git commit -m "feat(0.3): node-pg-migrate runner + db:migrate pre-deploy scripts"
```

---

## Task 6: Service entrypoints

**Files:**
- Create: `src/services/webhook-receiver.ts`, `src/services/worker.ts`, `src/services/reconciliation-cron.ts`, `src/services/retention-cron.ts`

These are thin glue and are verified by build + the manual deploy QA (their logic — readiness and keepAlive — is already unit-tested). No new unit test.

- [ ] **Step 1: Implement the two long-running services**

`src/services/webhook-receiver.ts`:

```ts
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { keepAlive } from '../boot/keepalive.js';

/**
 * Webhook-receiver entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, then holds open. NO HTTP listener yet — the real receiver and the
 * shared hardening/auth middleware land in Task 2.1/2.3, so the public domain 502s
 * until then; the deploy itself succeeds because the process stays up.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'webhook-receiver' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'webhook-receiver booted');
  await keepAlive();
}

main().catch((err: unknown) => {
  process.stderr.write(`webhook-receiver crashed: ${String(err)}\n`);
  process.exit(1);
});
```

`src/services/worker.ts` (identical shape; name and log message differ):

```ts
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { keepAlive } from '../boot/keepalive.js';

/**
 * Worker entrypoint (Task 0.3: infrastructure only). Boots, confirms dependencies,
 * then holds open. NO queue consumer yet — BullMQ wiring lands in Task 2.1. No
 * public domain.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'worker' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'worker booted');
  await keepAlive();
}

main().catch((err: unknown) => {
  process.stderr.write(`worker crashed: ${String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Implement the two crons**

`src/services/reconciliation-cron.ts`:

```ts
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';

/**
 * Reconciliation cron entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, logs, and exits so Railway re-invokes on schedule. NO reconciliation
 * logic yet — that lands in a later phase. A cron must terminate: no keepAlive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'reconciliation-cron' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'reconciliation-cron ran');
}

main().catch((err: unknown) => {
  process.stderr.write(`reconciliation-cron crashed: ${String(err)}\n`);
  process.exit(1);
});
```

`src/services/retention-cron.ts` (identical shape; name and log message differ):

```ts
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';

/**
 * Retention cron entrypoint (Task 0.3: infrastructure only). Boots, confirms
 * dependencies, logs, and exits so Railway re-invokes on schedule. NO purge logic
 * yet — deletion is a later phase and never runs in the per-call path. No keepAlive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'retention-cron' });
  await assertDependenciesReady(config, logger);
  logger.info({ node_env: config.NODE_ENV }, 'retention-cron ran');
}

main().catch((err: unknown) => {
  process.stderr.write(`retention-cron crashed: ${String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build && ls dist/services/`
Expected: PASS; `dist/services/` contains `webhook-receiver.js`, `worker.js`, `reconciliation-cron.js`, `retention-cron.js`.

- [ ] **Step 4: Commit**

```bash
git add src/services/
git commit -m "feat(0.3): four service entrypoints (boot + readiness + keepalive)"
```

---

## Task 7: Migrations directory + Railway deploy config

**Files:**
- Create: `migrations/.gitkeep`, `migrations/README.md`
- Create: `deploy/railway/{webhook-receiver,worker,reconciliation-cron,retention-cron}.json`, `deploy/railway/README.md`

- [ ] **Step 1: Create the migrations directory**

`migrations/.gitkeep`: empty file.

`migrations/README.md`:

```markdown
# migrations

node-pg-migrate migration files live here. **Empty in Task 0.3** — the actual schema
and reversible migrations are Task 1.1. `npm run db:migrate` (run as the Railway
pre-deploy command) applies every pending migration in this directory; an empty
directory is a valid no-op run. Every migration must have an `up` and a `down`.
```

- [ ] **Step 2: Create the four Railway config files**

`deploy/railway/webhook-receiver.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "startCommand": "node dist/services/webhook-receiver.js",
    "preDeployCommand": ["npm run db:migrate"],
    "restartPolicyType": "ON_FAILURE"
  }
}
```

`deploy/railway/worker.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "startCommand": "node dist/services/worker.js",
    "preDeployCommand": ["npm run db:migrate"],
    "restartPolicyType": "ON_FAILURE"
  }
}
```

`deploy/railway/reconciliation-cron.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "startCommand": "node dist/services/reconciliation-cron.js",
    "preDeployCommand": ["npm run db:migrate"],
    "cronSchedule": "*/15 * * * *",
    "restartPolicyType": "NEVER"
  }
}
```

`deploy/railway/retention-cron.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "startCommand": "node dist/services/retention-cron.js",
    "preDeployCommand": ["npm run db:migrate"],
    "cronSchedule": "0 4 * * *",
    "restartPolicyType": "NEVER"
  }
}
```

> `build.builder` is intentionally omitted — Railway defaults to Railpack (NIXPACKS is no longer a listed value). All cron schedules are UTC.

- [ ] **Step 3: Create the deploy README**

`deploy/railway/README.md`:

```markdown
# Railway deploy config

One config file per service. In the Railway dashboard, set each service's
**Config-as-code path** to its file here (e.g. `deploy/railway/worker.json`).

## Services

| Service | Config | Public domain | Schedule |
| --- | --- | --- | --- |
| webhook-receiver | `webhook-receiver.json` | yes (dashboard) | — |
| worker | `worker.json` | **no** | — |
| reconciliation-cron | `reconciliation-cron.json` | no | `*/15 * * * *` UTC |
| retention-cron | `retention-cron.json` | no | `0 4 * * *` UTC |

## By-hand dashboard steps (build plan Task 0.3)

- Add Postgres and Redis. Turn on Postgres point-in-time recovery and Redis
  persistence. Record the PITR retention window (matters for the deletion promise).
- Wire `DATABASE_URL` and `REDIS_URL` into every service as reference variables.
- Private networking only: neither Postgres nor Redis has a public endpoint.
- The worker has no public domain.
- `preDeployCommand` runs `npm run db:migrate` before each deploy. All four services
  run it; node-pg-migrate uses a pg advisory lock in `wait` mode, so concurrent
  pre-deploys serialize instead of failing.

## Known-and-expected in Task 0.3

- `webhook-receiver` has **no HTTP listener yet** (no `healthcheckPath`). Its public
  domain returns 502 until Task 2.1 adds the receiver and Task 2.3 the hardening/auth
  middleware. The deploy still succeeds because the process boots and stays up.
- `migrations/` is empty until Task 1.1, so `db:migrate` is a successful no-op.
```

- [ ] **Step 4: Commit**

```bash
git add migrations/ deploy/
git commit -m "feat(0.3): migrations dir + per-service Railway deploy config"
```

---

## Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run each and confirm PASS:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run format:check
npm audit --audit-level=high
```

Expected: lint clean; typecheck no errors; all vitest suites pass; build emits `dist/scripts/migrate.js` and `dist/services/*.js`; prettier reports no changes; audit reports no high/critical advisories.

- [ ] **Step 2: Fix any formatting**

If `format:check` fails: `npm run format`, then re-run `npm run format:check`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(0.3): verification gate fixups"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin task/0.3-railway-deploy
gh pr create --base main --title "Task 0.3: Railway deploy config + migration runner" \
  --body "Implements Task 0.3 infrastructure per docs/superpowers/specs/2026-06-30-railway-deploy-migration-runner-design.md. Per-service Railway config, node-pg-migrate pre-deploy runner (MIGRATION_FAILED on failure), DI boot readiness check (DATABASE_UNAVAILABLE / REDIS_UNAVAILABLE), signal-aware keepAlive. Infrastructure only, no business logic."
```

---

## Self-review notes (author)

- **Spec coverage:** config (`REDIS_URL` + timeouts, store URLs optional) → Task 1; error contract + flush → Task 2; readiness → Task 3; keepAlive → Task 4; migration runner + `advisoryLockMode: 'wait'` + TS→`dist` execution → Task 5; entrypoints (webhook no-listener, crons terminate) → Task 6; Railway config (builder omitted, array `preDeployCommand`, schedules) + migrations dir + dashboard README → Task 7; verification gate → Task 8. All spec §2–§11 items map to a task.
- **Manual-only QA (not automatable in CI):** live Postgres/Redis reachability, real concurrent-lock serialization, per-service deploy success, and the worker-has-no-public-domain check are done by hand during the deploy, per the spec.
- **Type consistency:** `FatalBootError(code, message, context)`, `failBoot(logger, error, { exit })`, `assertDependenciesReady(config, logger, deps)`, `PgProbe`/`RedisProbe`, `runMigrations(direction, deps)`, `keepAlive({ onShutdown })`, `createBootLogger({ level, name })` are used identically across every task that references them.
