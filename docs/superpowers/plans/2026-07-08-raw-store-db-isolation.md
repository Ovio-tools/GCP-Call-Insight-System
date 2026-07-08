# Raw-Store DB Isolation — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `raw_transcripts` + `token_vault` into a separate Railway Postgres (DB-B) whose backups are off, so the highest-sensitivity data never enters a long-lived backup — while keeping every privacy/finality guarantee intact.

**Architecture:** A second Postgres (DB-B) holds only `raw_transcripts`, `token_vault`, and a new DB-B-local `raw_purge_tombstone`. Everything else stays in DB-A (which keeps deep backups; it holds only de-identified data). A second connection (`RAW_DATABASE_URL`), a second pool family, and a second migration set target DB-B. The three cross-table couplings that today rely on a shared-DB transaction with `review_queue` are reworked: the "never repopulate a purged call" finality guard moves to the DB-B-local tombstone (atomic within DB-B again); the retention RAW-group and held-cap purges become two-pool with the DB-A review check done as an application-level pre-filter. Cross-DB foreign keys (`call_id → call_state`, `key_version → key_versions`) are dropped (Postgres cannot enforce them across databases) and become application-enforced logical references.

**Tech Stack:** Node.js + TypeScript (strict), vitest, pg, node-pg-migrate, zod config.

**Companion spec:** `docs/superpowers/specs/2026-07-08-railway-secret-keystore-and-raw-store-isolation-design.md` (Move 2). **Depends on nothing in Plan 1** — can merge before or after it.

---

## Load-bearing consequences (read before starting)

1. **Cross-DB FKs are dropped.** `raw_transcripts` and `token_vault` currently declare `call_id → call_state ON DELETE RESTRICT` and `key_version → key_versions ON DELETE RESTRICT`. `call_state` and `key_versions` stay in DB-A, so these FKs cannot exist across databases. In DB-B they become plain `text` / `integer` columns. The `ON DELETE RESTRICT` protections are gone; nothing else referenced them for correctness (call_state is never purged; key removal being independent is actually desirable for crypto-shred).
2. **Finality guard moves to DB-B.** The "don't repopulate a held-cap-purged call" guard (today an in-SQL `NOT EXISTS (SELECT … FROM review_queue WHERE raw_purged_at IS NOT NULL)`) is replaced by a DB-B-local `raw_purge_tombstone` check — same DB as the write, so it stays atomic and race-free. `review_queue.raw_purged_at` in DB-A is kept as a best-effort audit mirror only.
3. **Two test databases.** DB integration tests need both `TEST_DATABASE_URL` (DB-A) and a new `TEST_RAW_DATABASE_URL` (DB-B). Without the raw one, DB-B suites skip (same pattern as today).

---

## File Structure

**Create:**
- `migrations-raw/1782864100001_raw_store_roles.cjs` — app/restricted/purge roles in DB-B.
- `migrations-raw/1782864100002_raw_store_tables.cjs` — `raw_transcripts`, `token_vault`, `raw_purge_tombstone` (no cross-DB FKs) + grants.
- `migrations-raw/lib/columns.cjs` — copy of the retention-columns helper for the DB-B set (self-contained; the DB-A `migrations/lib/columns.cjs` is not on DB-B's path).
- `migrations-raw/README.md` — one line: "DB-B (raw store) migrations; run against RAW_DATABASE_URL."
- `src/db/raw-store.ts` — raw-store pool factory (`createRawAppPool`/`createRawRestrictedRunner`/`createRawPurgePool`) + a `rawStoreReady` check.
- `src/db/repositories/raw-purge-tombstone-repo.ts` — `isRawPurged`, `insertRawTombstone`.
- `migrations/1782864100000_drop_raw_store_tables_from_main.cjs` — DB-A migration dropping `raw_transcripts` + `token_vault` (down recreates).
- `test/db/raw-store.test.ts`, `test/db/raw-purge-tombstone-repo.test.ts`, `test/db/backup-isolation-guard.test.ts`.

**Modify:**
- `src/config/schema.ts` — `RAW_DATABASE_URL`.
- `src/boot/readiness.ts` — require + probe `RAW_DATABASE_URL` in staging/prod.
- `src/boot/migrate-runner.ts` + `src/scripts/migrate.ts` — run the DB-B set too.
- `src/db/repositories/raw-transcripts-repo.ts` — tombstone finality guard (drop the review_queue subquery).
- `src/db/restricted/token-vault-repo.ts` — tombstone finality guard.
- `src/db/repositories/review-queue-repo.ts` — split held-cap into DB-A eligibility read + `markRawPurged` (audit); remove raw/vault DELETE responsibility.
- `src/retention/purge.ts` — RAW group + held-cap become two-pool with a DB-A review pre-filter.
- `src/retention/run.ts` / `src/services/retention-cron.ts` — build + pass `rawPurgePool`.
- The raw/vault consumers' DI: `src/pipeline/redact.ts`, `src/pipeline/mark-retention-eligible.ts`, `src/review/reveal.ts` / `raw-access.ts` / `queries.ts`, `src/backfill/ingest.ts` (repoint to the raw pool/runner), and the worker/service bootstraps that construct these pools.
- `.env.example`, `CLAUDE.md`, `docs/adr/0008-*.md`, `docs/backup-retention.md`.

---

## Phase A — Config & pools

### Task 1: `RAW_DATABASE_URL` config + readiness

**Files:**
- Modify: `src/config/schema.ts`, `src/boot/readiness.ts`
- Test: `test/config/raw-database-url.test.ts`, and the existing readiness test file

- [ ] **Step 1: Failing config test** — create `test/config/raw-database-url.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

describe('config — RAW_DATABASE_URL', () => {
  it('accepts an optional RAW_DATABASE_URL', () => {
    const parsed = configSchema.parse({ NODE_ENV: 'test', LOG_LEVEL: 'info', RAW_DATABASE_URL: 'postgres://x' });
    expect(parsed.RAW_DATABASE_URL).toBe('postgres://x');
  });
  it('leaves it undefined when unset', () => {
    const parsed = configSchema.parse({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
    expect(parsed.RAW_DATABASE_URL).toBeUndefined();
  });
});
```

(Confirm the exported schema symbol name — `configSchema` or `configObjectSchema` — and import to match.)

- [ ] **Step 2: Run — FAIL.** `npx vitest run test/config/raw-database-url.test.ts` → property missing.

- [ ] **Step 3: Add the setting** in `src/config/schema.ts`, right after `DATABASE_URL` (~line 72):

```typescript
  /** DB-B (raw store) connection. Holds ONLY raw_transcripts + token_vault + raw_purge_tombstone,
   * on a Postgres whose backups are off (ADR 0008 Move 2). Optional at boot like DATABASE_URL;
   * readiness requires + probes it in staging/production. */
  RAW_DATABASE_URL: z.string().min(1).optional(),
```

- [ ] **Step 4: Require + probe it in readiness.** In `src/boot/readiness.ts`, wherever `DATABASE_URL` is required and probed for staging/production, add the same treatment for `RAW_DATABASE_URL` (fail-fast `CONFIG_MISSING_OR_INVALID` naming `RAW_DATABASE_URL` when absent in staging/prod; a `SELECT 1` connectivity probe on a short-lived owner pool). Mirror the exact existing `DATABASE_URL` block — same helper, same error code, second variable.

- [ ] **Step 5: Update `.env.example`:**

```dotenv
# DB-B: raw store (raw_transcripts + token_vault) on a backups-OFF Postgres — ADR 0008 Move 2
RAW_DATABASE_URL=
```

- [ ] **Step 6: Run tests + typecheck.** `npx vitest run test/config test/boot/readiness*` and `npm run typecheck` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/config/schema.ts src/boot/readiness.ts .env.example test/config/raw-database-url.test.ts
git commit -m "feat(config): RAW_DATABASE_URL for the raw-store DB + readiness probe"
```

---

### Task 2: Raw-store pool factory

**Files:**
- Create: `src/db/raw-store.ts`
- Test: `test/db/raw-store.test.ts`
- Modify: `src/db/index.ts` (export)

- [ ] **Step 1: Failing test** — `test/db/raw-store.test.ts` (DB-gated, skips without `TEST_RAW_DATABASE_URL`):

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { createRawAppPool } from '../../src/db/raw-store.js';

const RAW_URL = process.env.TEST_RAW_DATABASE_URL;
const maybe = RAW_URL ? describe : describe.skip;

maybe('createRawAppPool', () => {
  const pool = createRawAppPool(RAW_URL!);
  afterAll(async () => { await pool.end(); });

  it('connects and runs as app_role', async () => {
    const res = await pool.query<{ role: string }>('SELECT current_user AS role');
    expect(res.rows[0]?.role).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing): `TEST_RAW_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_raw_test npx vitest run test/db/raw-store.test.ts`

- [ ] **Step 3: Write `src/db/raw-store.ts`** (thin wrappers over the existing pool/runner factories, bound to the raw connection):

```typescript
import type { Pool } from 'pg';
import { createAppPool, createOwnerPool } from './pool.js';
import { createRestrictedRunner, type RestrictedRunner } from './restricted/restricted-context.js';

/** app_role pool on DB-B — raw_transcripts reads/writes + tombstone checks. */
export function createRawAppPool(rawDatabaseUrl: string): Pool {
  return createAppPool(rawDatabaseUrl, 'app_role');
}

/** restricted_role runner on DB-B — token_vault reads/writes. */
export function createRawRestrictedRunner(rawDatabaseUrl: string): { pool: Pool; runner: RestrictedRunner } {
  const pool = createAppPool(rawDatabaseUrl, 'app_role');
  return { pool, runner: createRestrictedRunner(pool) };
}

/** purge_role pool on DB-B — retention DELETE + tombstone INSERT. */
export function createRawPurgePool(rawDatabaseUrl: string): Pool {
  return createAppPool(rawDatabaseUrl, 'purge_role');
}

/** Owner pool on DB-B — migrations / test setup only. */
export function createRawOwnerPool(rawDatabaseUrl: string): Pool {
  return createOwnerPool(rawDatabaseUrl);
}
```

Note: the restricted runner uses `SET LOCAL ROLE restricted_role` inside a transaction, so its pool logs in as `app_role` and switches — identical to DB-A. The login user on DB-B must be a NOINHERIT member of `app_role`, `restricted_role`, and `purge_role` (documented in Task 13 / `docs/backup-retention.md`).

- [ ] **Step 4: Export** from `src/db/index.ts`:

```typescript
export { createRawAppPool, createRawRestrictedRunner, createRawPurgePool, createRawOwnerPool } from './raw-store.js';
```

- [ ] **Step 5: Run + typecheck.** PASS (or SKIP without the raw test DB) + `npm run typecheck`.

- [ ] **Step 6: Commit.**

```bash
git add src/db/raw-store.ts src/db/index.ts test/db/raw-store.test.ts
git commit -m "feat(db): raw-store pool factory (app/restricted/purge on DB-B)"
```

---

## Phase B — Migrations (schema split)

### Task 3: Run the DB-B migration set

**Files:**
- Modify: `src/scripts/migrate.ts`
- Create: `migrations-raw/README.md`
- Test: `test/boot/migrate-runner.test.ts` (extend)

`runMigrations(direction, { databaseUrl, migrationsDir })` already supports overrides — we call it a second time for DB-B.

- [ ] **Step 1: Extend the migrate entrypoint.** In `src/scripts/migrate.ts`, after the existing `await runMigrations(direction)` (DB-A), add:

```typescript
  // DB-B (raw store) — ADR 0008 Move 2. Runs only when RAW_DATABASE_URL is configured.
  if (process.env.RAW_DATABASE_URL) {
    await runMigrations(direction, {
      databaseUrl: process.env.RAW_DATABASE_URL,
      migrationsDir: 'migrations-raw',
    });
    logger.info({ direction, target: 'raw-store' }, 'raw-store migrations complete');
  }
```

Down ordering note: for `down`, DB-B rolls back one and DB-A rolls back one per invocation, symmetric to `up`. Keep both in the same command so a deploy migrates both stores together.

- [ ] **Step 2: Create `migrations-raw/README.md`:**

```markdown
# DB-B (raw store) migrations

Run against `RAW_DATABASE_URL` (see `src/scripts/migrate.ts`). Holds only
`raw_transcripts`, `token_vault`, and `raw_purge_tombstone`. See ADR 0008 (Move 2).
```

- [ ] **Step 3: Extend `test/boot/migrate-runner.test.ts`** — add a case asserting that when a `databaseUrl`/`migrationsDir` override is passed, the injected stub runner receives them (the runner already supports this; the test locks the contract migrate.ts relies on):

```typescript
it('honors databaseUrl + migrationsDir overrides', async () => {
  const calls: Record<string, unknown>[] = [];
  const runner = (opts: Record<string, unknown>) => { calls.push(opts); return Promise.resolve(); };
  await runMigrations('up', { runner, databaseUrl: 'postgres://raw', migrationsDir: 'migrations-raw' });
  expect(calls[0]).toMatchObject({ databaseUrl: 'postgres://raw', dir: 'migrations-raw' });
});
```

- [ ] **Step 4: Run + typecheck.** `npx vitest run test/boot/migrate-runner.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/scripts/migrate.ts migrations-raw/README.md test/boot/migrate-runner.test.ts
git commit -m "feat(migrate): run the raw-store migration set against RAW_DATABASE_URL"
```

---

### Task 4: DB-B schema — roles, tables (no cross-DB FKs), tombstone, grants

**Files:**
- Create: `migrations-raw/lib/columns.cjs`, `migrations-raw/1782864100001_raw_store_roles.cjs`, `migrations-raw/1782864100002_raw_store_tables.cjs`

- [ ] **Step 1: Copy the retention-columns helper.** Create `migrations-raw/lib/columns.cjs` as a copy of `migrations/lib/columns.cjs` (so the DB-B set is self-contained). Read the DB-A file and reproduce it verbatim.

- [ ] **Step 2: Roles migration** — `migrations-raw/1782864100001_raw_store_roles.cjs`, a copy of the DB-A `1782864000004_roles.cjs` (same three existence-guarded, marker-stamped roles `app_role`/`restricted_role`/`purge_role`, same `down`). Reproduce it verbatim from the file read in exploration.

- [ ] **Step 3: Tables + tombstone + grants migration** — `migrations-raw/1782864100002_raw_store_tables.cjs`:

```javascript
'use strict';

/**
 * DB-B (raw store) tables — ADR 0008 Move 2. Holds ONLY the highest-sensitivity stores, on a
 * Postgres whose backups are off. Cross-DB FKs to call_state / key_versions (DB-A) are dropped:
 * Postgres cannot enforce a foreign key across databases, so call_id/key_version are plain
 * columns here (application-enforced references).
 *
 * raw_purge_tombstone is the DB-B-local finality marker: the held-cap purge deletes raw/vault AND
 * inserts the tombstone in ONE DB-B transaction, and the writers check it (same DB → atomic,
 * race-free), preserving the "a purged call is never repopulated" guarantee.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');
exports.shorthands = undefined;
const now = (pgm) => pgm.func('now()');

/** @param {MB} pgm */
exports.up = (pgm) => {
  pgm.createTable('raw_transcripts', {
    call_id: { type: 'text', primaryKey: true }, // logical ref to DB-A call_state; no cross-DB FK
    ciphertext: { type: 'bytea', notNull: true },
    key_version: { type: 'integer', notNull: true }, // logical ref to DB-A key_versions; no FK
    fetched_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });

  pgm.createTable(
    'token_vault',
    {
      call_id: { type: 'text', notNull: true },
      token: { type: 'text', notNull: true },
      ciphertext: { type: 'bytea', notNull: true },
      key_version: { type: 'integer', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
      ...retentionColumns(),
    },
    { constraints: { primaryKey: ['call_id', 'token'] } },
  );

  // Finality marker: one row per call whose raw/vault were physically purged.
  pgm.createTable('raw_purge_tombstone', {
    call_id: { type: 'text', primaryKey: true },
    purged_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  // Grants (mirror DB-A migration 5, minus key_versions which lives in DB-A).
  pgm.sql('GRANT USAGE ON SCHEMA public TO app_role, restricted_role, purge_role;');
  // app_role: raw_transcripts DML (encrypted but not restricted); tombstone read for the writer guard.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON raw_transcripts TO app_role;');
  pgm.sql('GRANT SELECT ON raw_purge_tombstone TO app_role;');
  // restricted_role: the only reader/writer of token_vault; tombstone read for the writer guard.
  pgm.sql('REVOKE ALL ON token_vault FROM app_role;');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON token_vault TO restricted_role;');
  pgm.sql('GRANT SELECT ON raw_purge_tombstone TO restricted_role;');
  // purge_role: physical delete of raw/vault + writes the finality tombstone atomically.
  pgm.sql('GRANT DELETE ON raw_transcripts, token_vault TO purge_role;');
  pgm.sql('GRANT SELECT, INSERT ON raw_purge_tombstone TO purge_role;');
  // purge_role also soft/hard-updates raw_transcripts in the RAW retention group.
  pgm.sql('GRANT SELECT, UPDATE ON raw_transcripts TO purge_role;');
  pgm.sql('GRANT SELECT, UPDATE ON token_vault TO purge_role;');
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.sql('REVOKE ALL ON raw_transcripts, token_vault, raw_purge_tombstone FROM app_role, restricted_role, purge_role;');
  pgm.dropTable('raw_purge_tombstone');
  pgm.dropTable('token_vault');
  pgm.dropTable('raw_transcripts');
  pgm.sql('REVOKE USAGE ON SCHEMA public FROM app_role, restricted_role, purge_role;');
};
```

- [ ] **Step 4: Apply against the raw test DB and eyeball.** Run: `RAW_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_raw_test node dist/scripts/migrate.js up` after `npm run build` (or run node-pg-migrate directly on `migrations-raw`). Expected: three tables created, grants applied, no errors.

- [ ] **Step 5: Commit.**

```bash
git add migrations-raw/
git commit -m "feat(migrate): DB-B schema — raw/vault (no cross-DB FKs) + finality tombstone + grants"
```

---

### Task 5: DB-A migration — drop raw/vault from the main DB

**Files:**
- Create: `migrations/1782864100000_drop_raw_store_tables_from_main.cjs`

`raw_transcripts` + `token_vault` now live in DB-B, so DB-A must drop them. This is destructive; it is safe because production is not live and dev/staging DBs are recreatable. `down()` recreates them (verbatim from migrations 002/003) so the migration is reversible per convention.

- [ ] **Step 1: Write the drop migration:**

```javascript
'use strict';

/**
 * ADR 0008 Move 2 — raw_transcripts + token_vault move to DB-B (raw store). Drop them from DB-A.
 * DESTRUCTIVE but pre-production: no live data. down() recreates the tables + grants as they were
 * in migrations 002/003/005 so the change is reversible. match_keys stays in DB-A (unchanged).
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');
exports.shorthands = undefined;
const now = (pgm) => pgm.func('now()');

/** @param {MB} pgm */
exports.up = (pgm) => {
  // Grants first (migration 5 granted these), then the tables.
  pgm.sql('REVOKE ALL ON token_vault FROM restricted_role;');
  pgm.sql('REVOKE ALL ON raw_transcripts FROM app_role;');
  pgm.sql('REVOKE ALL ON raw_transcripts, token_vault FROM purge_role;');
  pgm.dropTable('token_vault');
  pgm.dropTable('raw_transcripts');
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.createTable('raw_transcripts', {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    ciphertext: { type: 'bytea', notNull: true },
    key_version: { type: 'integer', notNull: true, references: 'key_versions', onDelete: 'RESTRICT' },
    fetched_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });
  pgm.createTable(
    'token_vault',
    {
      call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
      token: { type: 'text', notNull: true },
      ciphertext: { type: 'bytea', notNull: true },
      key_version: { type: 'integer', notNull: true, references: 'key_versions', onDelete: 'RESTRICT' },
      created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
      ...retentionColumns(),
    },
    { constraints: { primaryKey: ['call_id', 'token'] } },
  );
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON raw_transcripts TO app_role;');
  pgm.sql('REVOKE ALL ON token_vault FROM app_role;');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON token_vault TO restricted_role;');
  pgm.sql('GRANT DELETE ON raw_transcripts, token_vault TO purge_role;');
};
```

Note: the migration-precondition offset tests (per project memory, ~5 sibling tests assert migration counts/offsets) will need their expected counts bumped for the new DB-A migration; update them in Task 13's verification when they surface.

- [ ] **Step 2: Recreate the DB-A test DB and migrate.** Because this changes the DB-A schema set, recreate the shared test DB (per project memory the safe fix for migration drift): drop/recreate `gcp_call_insights_test`, then `TEST` migrate up. Expected: `raw_transcripts`/`token_vault` absent from DB-A.

- [ ] **Step 3: Commit.**

```bash
git add migrations/1782864100000_drop_raw_store_tables_from_main.cjs
git commit -m "feat(migrate): drop raw_transcripts + token_vault from DB-A (moved to DB-B)"
```

---

## Phase C — Repoint consumers + finality-guard rework

### Task 6: Tombstone repo + `putTranscript` finality guard

**Files:**
- Create: `src/db/repositories/raw-purge-tombstone-repo.ts`
- Modify: `src/db/repositories/raw-transcripts-repo.ts`
- Test: `test/db/raw-purge-tombstone-repo.test.ts`, extend `test/db/raw-transcripts-repo*`

- [ ] **Step 1: Failing tombstone-repo test** — `test/db/raw-purge-tombstone-repo.test.ts` (DB-B-gated):

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { createRawAppPool, createRawPurgePool } from '../../src/db/raw-store.js';
import { isRawPurged, insertRawTombstone } from '../../src/db/repositories/raw-purge-tombstone-repo.js';

const RAW = process.env.TEST_RAW_DATABASE_URL;
const maybe = RAW ? describe : describe.skip;

maybe('raw_purge_tombstone repo', () => {
  const app = createRawAppPool(RAW!);
  const purge = createRawPurgePool(RAW!);
  afterAll(async () => { await app.end(); await purge.end(); });

  it('is false before, true after a tombstone insert', async () => {
    const callId = `t-${Date.now()}`;
    expect(await isRawPurged(app, callId)).toBe(false);
    await insertRawTombstone(purge, callId, new Date());
    expect(await isRawPurged(app, callId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Write `src/db/repositories/raw-purge-tombstone-repo.ts`:**

```typescript
import { query } from '../sql.js';
import type { Queryable } from '../types.js';

/** True if a call's raw/vault were physically purged (DB-B-local finality marker, ADR 0008). */
export async function isRawPurged(db: Queryable, callId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    db,
    `SELECT 1 AS one FROM raw_purge_tombstone WHERE call_id = $1 LIMIT 1`,
    [callId],
  );
  return rows.length > 0;
}

/** Insert the finality tombstone for a call. Idempotent (ON CONFLICT DO NOTHING). */
export async function insertRawTombstone(db: Queryable, callId: string, now: Date): Promise<void> {
  await query(
    db,
    `INSERT INTO raw_purge_tombstone (call_id, purged_at) VALUES ($1, $2)
     ON CONFLICT (call_id) DO NOTHING`,
    [callId, now],
  );
}
```

- [ ] **Step 4: Rework `putTranscript`** in `src/db/repositories/raw-transcripts-repo.ts`. Replace the `review_queue` subquery with the DB-B-local tombstone check (same DB, so still one atomic INSERT):

```typescript
  const rows = await query(
    pool,
    `INSERT INTO raw_transcripts (call_id, ciphertext, key_version)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM raw_purge_tombstone WHERE call_id = $1)
     ON CONFLICT (call_id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       key_version = EXCLUDED.key_version,
       fetched_at = now()
     WHERE raw_transcripts.hard_deleted_at IS NULL
     RETURNING 1 AS ok`,
    [v.callId, enc.ciphertext, enc.keyVersion],
  );
```

Update the doc comment on `putTranscript` to describe the tombstone guard instead of the review_queue guard (the two finality guards are now: (1) tombstone `NOT EXISTS`, (2) `hard_deleted_at IS NULL` on conflict). The zero-rows `DalError` message stays.

- [ ] **Step 5: Run tests + typecheck.** DB-B repo test PASS; existing raw-transcripts tests updated to seed a tombstone row instead of a review_queue row for the finality case. `npm run typecheck`.

- [ ] **Step 6: Commit.**

```bash
git add src/db/repositories/raw-purge-tombstone-repo.ts src/db/repositories/raw-transcripts-repo.ts test/db/raw-purge-tombstone-repo.test.ts test/db/raw-transcripts-repo*
git commit -m "feat(db): DB-B finality tombstone; putTranscript guards on it (not review_queue)"
```

---

### Task 7: `putToken` finality guard on the tombstone

**Files:**
- Modify: `src/db/restricted/token-vault-repo.ts`
- Test: extend `test/db/token-vault-repo*`

- [ ] **Step 1: Rework `putToken`** in `src/db/restricted/token-vault-repo.ts` — replace the `review_queue` subquery with the tombstone check (runs under `restricted_role`, which now has `SELECT` on `raw_purge_tombstone` in DB-B):

```typescript
    const rows = await query(
      client,
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM raw_purge_tombstone WHERE call_id = $1)
       ON CONFLICT (call_id, token) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         key_version = EXCLUDED.key_version,
         soft_deleted_at = NULL
       WHERE token_vault.hard_deleted_at IS NULL
       RETURNING 1 AS ok`,
      [v.callId, v.token, enc.ciphertext, enc.keyVersion],
    );
```

Update the doc comment (guard #1 is now the tombstone, not the migration-013 review_queue columns).

- [ ] **Step 2: Update the token-vault tests** to seed a `raw_purge_tombstone` row for the finality case (instead of a `review_queue` row with `raw_purged_at`). Run under the DB-B test DB.

- [ ] **Step 3: Run + typecheck.** PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/db/restricted/token-vault-repo.ts test/db/token-vault-repo*
git commit -m "feat(db): putToken finality guard on DB-B tombstone"
```

---

### Task 8: Repoint the raw/vault consumers to the raw pool

**Files (DI/wiring only — no behavior change beyond the target DB):**
- Modify: `src/pipeline/redact.ts`, `src/pipeline/mark-retention-eligible.ts`, `src/review/reveal.ts`, `src/review/raw-access.ts`, `src/review/queries.ts`, `src/backfill/ingest.ts`, and the worker/service bootstraps that build these pools.

The DAL functions already take a `pool`/`runner` argument — this task threads the **raw** pool/runner to exactly the raw/vault call sites and leaves DB-A calls alone.

- [ ] **Step 1: Inventory the call sites.** Run: `grep -rn "putTranscript\|getTranscript\|transcriptExists\|markTranscriptRetentionEligible\|putToken\|getToken\|tokenExistsForCall\|markTokensRetentionEligible\|createRestrictedRunner" src/` and list each caller with its current pool source.

- [ ] **Step 2: Add the raw pool/runner to each caller's dependencies.** For each service/stage that constructs pools at boot (worker, review surface, backfill, retention), build the raw app pool + raw restricted runner from `config.RAW_DATABASE_URL` via `createRawAppPool` / `createRawRestrictedRunner` (Task 2) and pass them where the raw/vault repos are called. Concretely:
  - `redact.ts`: the transcript read (`getTranscript`) and vault writes (`putToken` via the restricted runner) use the **raw** pool/runner; the clean-transcript + findings writes stay on the DB-A pool.
  - `mark-retention-eligible.ts`: `markTranscriptRetentionEligible` (raw pool) + `markTokensRetentionEligible` (raw runner); the clean/extraction stamps stay DB-A.
  - `review/reveal.ts` + `raw-access.ts` + `queries.ts`: the "reveal original" reads (`getTranscript`, `getToken`, `tokenExistsForCall`, `transcriptExists`) use the raw pool/runner; review_queue/audit stay DB-A.
  - `backfill/ingest.ts`: `putTranscript` (raw pool) + vault writes (raw runner).

- [ ] **Step 3: Update each stage/service test** to inject a raw pool/runner (the DB-gated tests use `TEST_RAW_DATABASE_URL`; the unit tests inject fakes). Where a test builds `runPipeline`, extend the shim (per project memory `test/_run-pipeline.ts`) to accept + thread the raw pool/runner.

- [ ] **Step 4: Run the pipeline/review/backfill suites + typecheck.** Under both `TEST_DATABASE_URL` and `TEST_RAW_DATABASE_URL`. PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/pipeline/redact.ts src/pipeline/mark-retention-eligible.ts src/review/ src/backfill/ingest.ts test/
git commit -m "feat: route raw_transcripts + token_vault access to the raw-store pool"
```

---

### Task 9: Fail closed when DB-B is unreachable

**Files:**
- Modify: `src/pipeline/redact.ts` (hold on raw-store write failure)
- Test: `test/pipeline/redact*` (add a DB-B-down case)

- [ ] **Step 1: Failing test** — inject a raw pool/runner whose `putToken`/`putTranscript` throws a connection error; assert the call is **held** (not advanced), mapped to `DATABASE_UNAVAILABLE`, with no clean-transcript egress. Use the existing redact test harness + a stub runner that rejects.

- [ ] **Step 2: Ensure the hold path.** Confirm redact already treats a vault/transcript write failure as fail-closed (it should, since a failed `putToken` throws a `DalError`); if the raw-store connection error is not already caught into a hold, wrap the raw writes so a DB-B outage becomes a hold with `DATABASE_UNAVAILABLE`, never a silent skip or an egress. Keep the failure-model mapping (`src/failure-model/`) consistent with existing DB-unavailable handling.

- [ ] **Step 3: Run + typecheck.** PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/pipeline/redact.ts test/pipeline/
git commit -m "feat(redact): fail closed (hold) when the raw store is unreachable"
```

---

## Phase D — Retention purge (two-pool)

### Task 10: RAW group purge on DB-B with a DB-A review pre-filter

**Files:**
- Modify: `src/retention/purge.ts`
- Test: `test/retention/purge*` (two-DB cases)

The RAW coupled group (`raw_transcripts` parent + `token_vault` child) both live in DB-B, so the coupling stays intra-DB-B. Only the `review_queue` blocking predicate is cross-DB and must move out of SQL into an application-level pre-filter.

- [ ] **Step 1: Add a `rawPool` to `PurgeDeps`** and a DB-A `blockedCallIds` reader. In `src/retention/purge.ts`:

```typescript
export interface PurgeDeps {
  /** Pool bound to `purge_role` on DB-A (CLEAN/WEBHOOK/MATCH/EXTRACT + review reads). */
  pool: Pool;
  /** Pool bound to `purge_role` on DB-B (RAW group + held-cap deletes). */
  rawPool: Pool;
  config: Config;
  logger: Logger;
  now: Date;
}
```

Add a helper that asks DB-A which of a candidate set of call_ids are review-blocked (mirrors `rawBlocking`, but as a query returning the blocked subset):

```typescript
/** Subset of `callIds` that DB-A says still block a raw purge (open/in_review/unresolvable, not
 * yet cap-purged). Fail-safe: the caller excludes these from deletion. */
async function blockedRawCallIds(dbA: PoolClient, callIds: string[]): Promise<Set<string>> {
  if (callIds.length === 0) return new Set();
  const rows = await dbA.query<{ call_id: string }>(
    `SELECT DISTINCT call_id FROM review_queue
       WHERE call_id = ANY($1::text[]) AND status IN ('open','in_review','unresolvable')
         AND raw_purged_at IS NULL`,
    [callIds],
  );
  return new Set(rows.map((r) => r.call_id));
}
```

- [ ] **Step 2: Rework the RAW group to run on DB-B with the pre-filter.** Extract the RAW group into a dedicated `purgeRawGroup(ctx, dbA, spec)` that: (a) selects candidate call_ids from DB-B by window (no `review_queue` subquery); (b) calls `blockedRawCallIds(dbA, ids)` and removes blocked ids; (c) soft/hard-updates the surviving ids in DB-B (`raw_transcripts` + `token_vault` together, same DB-B transaction). The CLEAN/WEBHOOK/MATCH/EXTRACT groups stay exactly as-is on the DB-A `client`. Remove the `blocking: 'raw'` path from `purgeCoupled` (RAW no longer uses the in-SQL predicate); CLEAN keeps `blocking: 'clean'` (review_queue and clean_transcripts are both DB-A — unchanged).

Concretely, in `runPurge`, replace the `purgeCoupled(ctx, { group: 'RAW', … })` call with `await purgeRawGroup(rawCtx, dbAClient, { softDays, hardDays })`, where `rawCtx` is a `PurgeContext` bound to a `rawPool` client. Acquire a DB-B client alongside the DB-A client; hold the existing DB-A advisory lock, plus a DB-B advisory lock (`SELECT pg_try_advisory_lock(RETENTION_ADVISORY_LOCK_KEY)` on the raw client) so two runs can't race DB-B either.

- [ ] **Step 3: Tests.** Two-DB retention test: seed raw/vault in DB-B (eligible), seed a blocking review in DB-A → assert NOT purged; clear the review → assert purged (soft then hard on a later run). Assert `token_vault` is dragged with its parent. Dry-run counts still reported.

- [ ] **Step 4: Run + typecheck.** PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/retention/purge.ts test/retention/
git commit -m "feat(retention): RAW purge runs on DB-B with a DB-A review pre-filter"
```

---

### Task 11: Held-cap purge — cross-DB with the DB-B tombstone

**Files:**
- Modify: `src/retention/purge.ts` (`purgeHeldCap`), `src/db/repositories/review-queue-repo.ts`
- Test: `test/retention/purge*` (held-cap two-DB)

Today `purgeHeldCap` deletes raw/vault + `markRawPurged` in one DB-A transaction. Now: eligibility comes from DB-A (`listRawPurgeEligible`), the delete + **tombstone insert** happen atomically in DB-B, and `markRawPurged` on DB-A becomes a best-effort audit stamp.

- [ ] **Step 1: Rework `purgeHeldCap`** to take both clients:

```typescript
async function purgeHeldCap(ctx: PurgeContext, rawClient: PoolClient, capHours: number): Promise<void> {
  const { client, now, batch, dryRun } = ctx; // client = DB-A
  const group = 'HELD_CAP';
  const window = `cap=${capHours}h`;

  if (dryRun) {
    const count = await step({ group, table: 'review_queue', action: 'held_cap_purge', dry_run: true },
      () => countRawPurgeEligible(client, capHours, now));
    pushAction(ctx, { table: 'raw_transcripts', group, action: 'held_cap_purge', window, count });
    pushAction(ctx, { table: 'token_vault', group, action: 'held_cap_purge', window, count });
    addGroupCalls(ctx, group, 'held_cap_purge', count);
    return;
  }

  let purged = 0;
  for (;;) {
    const candidates = await step({ group, table: 'review_queue', action: 'held_cap_purge', dry_run: false },
      () => listRawPurgeEligible(client, capHours, now, batch));
    if (candidates.length === 0) break;
    for (const row of candidates) {
      // Atomic in DB-B: delete raw/vault AND write the finality tombstone together.
      await step({ group, table: 'raw_transcripts', action: 'held_cap_purge', dry_run: false }, () =>
        withClientTransaction(rawClient, async (rc) => {
          await rc.query(`DELETE FROM token_vault WHERE call_id = $1`, [row.call_id]);
          await rc.query(`DELETE FROM raw_transcripts WHERE call_id = $1`, [row.call_id]);
          await insertRawTombstone(rc, row.call_id, now);
        }),
      );
      // Best-effort audit stamp on DB-A (never blocks finality; re-list is harmless/idempotent).
      await step({ group, table: 'review_queue', action: 'held_cap_purge', dry_run: false }, () =>
        markRawPurged(client, row.id, now));
      purged += 1;
    }
    if (candidates.length < batch) break;
  }
  pushAction(ctx, { table: 'raw_transcripts', group, action: 'held_cap_purge', window, count: purged });
  pushAction(ctx, { table: 'token_vault', group, action: 'held_cap_purge', window, count: purged });
  addGroupCalls(ctx, group, 'held_cap_purge', purged);
}
```

Add `import { insertRawTombstone } from '../db/repositories/raw-purge-tombstone-repo.js';`. Update `runPurge` to call `await purgeHeldCap(ctx, rawClient, config.REVIEW_HELD_RAW_RETENTION_CAP_HOURS);`.

Idempotency note (call out in the doc comment): if the process dies after the DB-B commit but before `markRawPurged`, the next run re-lists the call (DB-A still `raw_purged_at IS NULL`), the DB-B delete is a no-op, `insertRawTombstone` is `ON CONFLICT DO NOTHING`, and `markRawPurged` finally stamps — converging with no double-effect. Finality is guaranteed by the DB-B tombstone the instant the DB-B commit lands; the DB-A stamp is only the audit mirror.

- [ ] **Step 2: Tests.** Held-cap two-DB: seed an over-cap held review in DB-A + raw/vault in DB-B → run → assert raw/vault gone from DB-B, tombstone present in DB-B, `raw_purged_at` stamped in DB-A. Simulate a `markRawPurged` failure after the DB-B delete → assert a re-run converges (tombstone stays, stamp lands).

- [ ] **Step 3: Run + typecheck.** PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/retention/purge.ts test/retention/
git commit -m "feat(retention): held-cap purge deletes DB-B + tombstone atomically; DB-A stamp is audit"
```

---

### Task 12: Wire `rawPurgePool` into the retention service

**Files:**
- Modify: `src/services/retention-cron.ts`, `src/retention/run.ts` (whichever constructs `runPurge`'s deps), and the retention entrypoint that builds pools.
- Test: `test/services/retention*`

- [ ] **Step 1: Build + pass the raw purge pool.** Add `rawPurgePool: Pool` to `RetentionServiceDeps`; where the entrypoint builds `purgePool = createAppPool(DATABASE_URL, 'purge_role')`, also build `rawPurgePool = createRawPurgePool(config.RAW_DATABASE_URL)` and pass it into `runPurge({ pool: purgePool, rawPool: rawPurgePool, … })`. End both pools on shutdown.

- [ ] **Step 2: Update the default `purge` thunk** in `runRetentionService` to include `rawPool`.

- [ ] **Step 3: Tests.** Update the retention-service tests to inject a `rawPool` (DB-gated) or a fake. Assert a raw-store purge failure still records one `RETENTION_PURGE_FAILED` on the DB-A `appPool` and rethrows without pinging (unchanged contract).

- [ ] **Step 4: Run + typecheck.** PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/retention-cron.ts src/retention/run.ts test/services/
git commit -m "feat(retention): wire the DB-B purge_role pool into the retention cron"
```

---

## Phase E — Guardrail, tests, docs

### Task 13: Backup-isolation guard + full two-DB verification

**Files:**
- Create: `test/db/backup-isolation-guard.test.ts`
- Modify: migration-precondition offset tests (bump counts for the new DB-A migration)

- [ ] **Step 1: Structural guard test** — assert raw/vault live ONLY in DB-B and are ABSENT from DB-A:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerPool } from '../../src/db/pool.js';
import { createRawOwnerPool } from '../../src/db/raw-store.js';

const A = process.env.TEST_DATABASE_URL;
const B = process.env.TEST_RAW_DATABASE_URL;
const maybe = A && B ? describe : describe.skip;

async function tableExists(pool: import('pg').Pool, name: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`, [name]);
  return r.rows[0]!.exists;
}

maybe('backup isolation: raw/vault only in DB-B', () => {
  const a = createOwnerPool(A!);
  const b = createRawOwnerPool(B!);
  afterAll(async () => { await a.end(); await b.end(); });

  it('raw_transcripts + token_vault are absent from DB-A', async () => {
    expect(await tableExists(a, 'raw_transcripts')).toBe(false);
    expect(await tableExists(a, 'token_vault')).toBe(false);
  });
  it('raw_transcripts + token_vault + tombstone exist in DB-B', async () => {
    expect(await tableExists(b, 'raw_transcripts')).toBe(true);
    expect(await tableExists(b, 'token_vault')).toBe(true);
    expect(await tableExists(b, 'raw_purge_tombstone')).toBe(true);
  });
  it('DB-A still has the de-identified stores (clean_transcripts, structured_knowledge)', async () => {
    expect(await tableExists(a, 'clean_transcripts')).toBe(true);
    expect(await tableExists(a, 'structured_knowledge')).toBe(true);
  });
});
```

- [ ] **Step 2: Fix migration-offset sibling tests.** Run the migration-precondition tests; where they assert a fixed DB-A migration count/offset, bump for `1782864100000_drop_raw_store_tables_from_main.cjs` (per project memory this pattern recurs — ~5 tests).

- [ ] **Step 3: Full suite, both DBs.** Run: `TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test TEST_RAW_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_raw_test npm run test`. Expected: green. The no-PII-egress + corpus tests must stay green (raw never leaves Railway is unchanged; the store just moved DBs).

- [ ] **Step 4: Commit.**

```bash
git add test/
git commit -m "test(db): backup-isolation structural guard + migration-offset bumps"
```

---

### Task 14: Docs + final gate

**Files:**
- Modify: `docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md` (Move 2 section), `CLAUDE.md` (data-store table + §1.2), `docs/backup-retention.md`, `.env.example`

- [ ] **Step 1: ADR 0008 Move 2.** Add a Move 2 section: the two-DB layout; DB-B backups off; cross-DB FK removal (accepted, application-enforced); the DB-B-local `raw_purge_tombstone` finality marker and why it replaces the shared-DB atomic guard; the two-pool retention purge with the DB-A review pre-filter.

- [ ] **Step 2: CLAUDE.md.** In §2 the data-store table, note `raw_transcripts` + `token_vault` live in the separate raw-store DB (DB-B, backups off) with `raw_purge_tombstone`; in §1.2 the privacy boundary, note the physical DB isolation. Add `RAW_DATABASE_URL` to the config/env expectations. Keep the terse house style.

- [ ] **Step 3: `docs/backup-retention.md`.** Document: DB-A PITR ~30 days (de-identified only); DB-B backups off (or ≤1 day); the DB-B login user must be a NOINHERIT member of `app_role`/`restricted_role`/`purge_role`; how restore works per store.

- [ ] **Step 4: `.env.example`** — ensure `RAW_DATABASE_URL` present (from Task 1) and add a `TEST_RAW_DATABASE_URL` comment for the test setup.

- [ ] **Step 5: Full gate.** `npm run lint && npm run typecheck && npm run build && npm run format:check && npm audit --audit-level=high`, and the full test run from Task 13 Step 3. All green.

- [ ] **Step 6: Commit + PR.**

```bash
git add docs/ CLAUDE.md .env.example
git commit -m "docs: ADR 0008 Move 2 + data-store/backup docs for the raw-store DB"
git push -u origin task/8.2c-railway-keystore-raw-isolation
gh pr create --base main --title "feat: isolate raw_transcripts + token_vault into a backups-off raw-store DB — ADR 0008 (Move 2)" --body "$(cat <<'EOF'
Move 2 of the Railway-secret + raw-store-isolation design.

- raw_transcripts + token_vault move to a separate Railway Postgres (DB-B) whose backups are off; DB-A keeps deep backups (de-identified data only).
- New DB-B-local raw_purge_tombstone preserves the atomic "never repopulate a purged call" guarantee (the writers + held-cap purge now key off it, same DB).
- Cross-DB FKs (call_id/key_version) dropped — application-enforced (Postgres can't span DBs).
- Retention RAW group + held-cap reworked to two-pool with a DB-A review pre-filter.
- Second migration set (migrations-raw/) run against RAW_DATABASE_URL.

Needs TEST_RAW_DATABASE_URL for the DB-B suites. Depends on nothing in Plan 1 (Railway key store) — either order merges.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed during authoring)

- **Spec coverage (Move 2):** `RAW_DATABASE_URL` + second pool (Tasks 1–2) ✓; only raw/vault move, everything else stays DB-A (Tasks 4–5, 8) ✓; DB-B backups off documented (Task 14) ✓; own restricted/purge roles + grants (Task 4) ✓; migration split + second runner (Tasks 3–5) ✓; key-metadata stays in DB-A, logical version ref (Tasks 4–5) ✓; cross-DB deletion with DB-A review check (Tasks 10–11) ✓; DB-B-local finality marker (Tasks 4, 6, 7, 11 — the refinement the spec now records) ✓; fail-closed when DB-B down (Task 9) ✓; go-live rules unchanged here (owned by Plan 1) ✓.
- **Consequences surfaced:** cross-DB FK removal (Task 5 + top-of-plan note); two test DBs (Task 13); destructive DB-A drop is pre-prod + reversible (Task 5).
- **Placeholders:** none for the crux (config, migrations, tombstone repo, finality guards, purge rework — full code). The repointing task (8) is exact-call-site DI threading over functions whose signatures already take a pool/runner; it lists every call site to change and the rule (raw calls → raw pool) rather than duplicating each caller's body. The two build-time confirmations (config schema symbol name; the exact list from the Task 8 grep) are called out explicitly.
- **Type consistency:** `PurgeDeps` gains `rawPool` and every `runPurge` caller updated (Tasks 10, 12); `isRawPurged`/`insertRawTombstone` signatures match across the repo (Task 6), the writers (Tasks 6–7), and held-cap (Task 11); `createRawAppPool`/`createRawRestrictedRunner`/`createRawPurgePool` used identically in Tasks 2, 8, 12, 13.
