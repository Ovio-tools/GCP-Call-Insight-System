# Design: Railway deploy config, migration runner, and boot readiness check

- **Date:** 2026-06-30
- **Build-plan task:** 0.3 (Railway provisioning — the deploy/migration code half; dashboard steps are done by hand)
- **Branch:** `task/0.3-railway-deploy` (to be created from `main`)
- **Plan mode:** YES (deploy and migration code)
- **Status:** Approved design, pending implementation plan

## 1. Goal

Deliver the *infrastructure* for Task 0.3: a Railway deploy configuration for four
services sharing one codebase, a migration runner wired as the pre-deploy command,
and a boot readiness check. No business logic. The four services are
`webhook-receiver`, `worker`, `reconciliation-cron`, and `retention-cron`; each
reads `DATABASE_URL` and `REDIS_URL` from the environment.

Concretely, this task must satisfy the build plan's QA for Task 0.3:

- A trivial deploy of each service succeeds and the readiness check passes.
- Removing the Redis reference variable makes the worker **exit** with
  `REDIS_UNAVAILABLE`, not hang.
- The worker has no public domain.
- Redis and Postgres are reachable only over private networking (dashboard concern,
  documented here, verified by hand).

## 2. Scope

### In scope

- Add `REDIS_URL` (and two optional readiness timeouts) to the config schema and
  `.env.example`, in lockstep.
- Add runtime deps `pg`, `ioredis`, `node-pg-migrate`; dev dep `@types/pg`.
- A forerunner error module for the three boot-time taxonomy codes, including a
  `failBoot` helper that flushes before exit.
- A dependency-injected boot readiness check.
- A migration runner (up + down) exposed as npm scripts; the `up` script is the
  Railway pre-deploy command.
- A signal-aware `keepAlive()` helper for the two long-running services.
- Four thin service entrypoints.
- One committed Railway config file per service, plus a README documenting the
  by-hand dashboard steps.
- Unit tests for the readiness check, the migration wrapper, the error module
  (incl. flush-order), and `keepAlive`.

### Out of scope (deferred to their own tasks)

- Dashboard provisioning, PITR/persistence toggles, reference-variable wiring
  (by-hand steps; documented, not coded).
- A public-facing HTTP listener for `webhook-receiver` and the shared hardening/auth
  middleware — Task 2.1 / 2.3.
- BullMQ queue wiring and the per-call state machine — Task 2.1.
- The real shared failure-model modules — Task 2.2. This task ships a minimal
  forerunner, to be absorbed then.
- Any actual schema migration — Task 1.1. The `migrations/` directory ships empty
  (a `.gitkeep` + README); an empty run proves the runner without pre-empting the
  schema.

## 3. Design decisions (settled)

| Decision | Choice | Why |
| --- | --- | --- |
| Migration tooling | **node-pg-migrate** | Purpose-built for Postgres, native up/down matching the "every migration has an up and a down" convention, minimal custom code, programmatic API for structured error emission. |
| Deploy-config shape | **Per-service committed config files** under `deploy/railway/` | Explicit, version-controlled, reviewable; each Railway service points at its own config path. |
| Structure | **Shared boot modules + thin entrypoints** (Approach A) | Readiness embedded in each service's own boot is what makes the "remove Redis → worker exits" QA pass; DI keeps it unit-testable without live servers. |
| webhook-receiver in 0.3 | **No HTTP listener** — boots and stays up | Keeps 0.3 honestly infra-only; the deploy still succeeds. Real listener + hardening land in Task 2.1/2.3. |
| Error emission | **Forerunner module**, taxonomy-aligned | Mirrors the config loader shipping `CONFIG_MISSING_OR_INVALID` ahead of Task 2.2. Explicitly marked to fold into 2.2. |
| Store-URL ownership | **Readiness owns `DATABASE_URL` / `REDIS_URL`** — optional in config, validated by readiness | A required zod field would exit `CONFIG_MISSING_OR_INVALID` *before* readiness runs, so removing the Redis var could never surface `REDIS_UNAVAILABLE` (0.3 QA). Making the store URLs readiness-owned means a missing **or** unreachable store maps to the dependency-specific code, symmetric across Postgres/Redis. Revisits Task 0.2's config contract for `DATABASE_URL` (see §10). |
| pre-deploy on which services | **All four, with `advisoryLockMode: 'wait'`** | node-pg-migrate's default lock mode is **`fail`** (a concurrent run errors, it does not queue). Setting `'wait'` makes the four services' pre-deploy runs serialize on the advisory lock instead of failing a deploy; each service then guarantees the schema is current before it boots. |
| Railway builder | **Omit `build.builder`** (default Railpack) | `NIXPACKS` is no longer a listed builder value; current values are `RAILPACK` (default) and `DOCKERFILE`. Omitting relies on the default and avoids pinning a value that may drift. |
| retention-cron schedule | `0 4 * * *` (daily, 04:00 UTC) | Daily as required; off-peak. Trivially changeable. |

## 4. Config and dependencies

**`src/config/schema.ts`** (kept in lockstep with `.env.example`):

- `REDIS_URL: z.string().min(1).optional()` — Redis/BullMQ backend. **Optional at
  the config layer**: presence and reachability are owned by the readiness check so
  that a missing value maps to `REDIS_UNAVAILABLE`, not `CONFIG_MISSING_OR_INVALID`
  (§3, §6).
- `DATABASE_URL` — **relaxed from required to `z.string().min(1).optional()`** for
  the same reason: readiness owns presence + reachability and emits
  `DATABASE_UNAVAILABLE`. This is the one change that revisits Task 0.2's config
  contract (§10 covers the test update). Still format-validated (non-empty) when
  present.
- `DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — optional.
- `REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — optional.

`.env.example` keeps `DATABASE_URL` and `REDIS_URL` documented (they are still
expected in every real deployment) plus the two optional timeouts under the
"Optional (defaults shown)" section — the file and schema stay in lockstep.

**Dependencies:** `pg`, `ioredis`, `node-pg-migrate` (runtime); `@types/pg` (dev).
`ioredis` and `node-pg-migrate` ship their own types. New deps are covered by the
existing gitleaks / `npm audit` / Dependabot wiring; no CI change.

## 5. Error contract — forerunner to Task 2.2

**`src/boot/codes.ts`** — minimal, explicitly marked *"forerunner; fold into the
Task 2.2 failure model."*

- Exports stable codes: `DATABASE_UNAVAILABLE`, `REDIS_UNAVAILABLE`,
  `MIGRATION_FAILED` (each a member of the build-plan §4 root-cause taxonomy).
- `class FatalBootError extends Error` carrying `{ code, context }`.
  - `context` is **sanitized**: host, port, and database name only — **never** the
    full connection string (it holds the password), never PII. A dedicated helper
    derives sanitized context from a connection URL.
- `failBoot(logger, error, exit)` — logs exactly one structured `fatal` line
  `{ error_code, context }`, **flushes**, then `exit(1)`. "Exits loudly" = one
  actionable structured line + non-zero exit; never a bare stack trace as the alert.
  - **Flush-before-exit is required.** pino's default destination (sonic-boom on fd
    1) buffers, so a bare `process.exit(1)` can drop the fatal line — the opposite of
    "loudly." Two mitigations, both specified: (a) the boot/fatal path uses a
    **synchronous destination** (`pino.destination({ sync: true })`) so writes reach
    the fd immediately; (b) `failBoot` calls `logger.flush?.()` before invoking
    `exit`. The `exit` hook stays injectable, so a test asserts **flush is called
    before exit** (call-order assertion), not just that both happen.

## 6. Boot readiness check

**`src/boot/readiness.ts`** — `assertDependenciesReady(config, deps?)`:

1. **Postgres:** if `config.DATABASE_URL` is absent → `FatalBootError(DATABASE_UNAVAILABLE)`
   with context noting the variable is missing. Otherwise a `pg.Client` with
   `connectionTimeoutMillis = DB_CONNECT_TIMEOUT_MS` runs `SELECT 1`, then closes.
   Failure or timeout → `FatalBootError(DATABASE_UNAVAILABLE)`.
2. **Redis:** if `config.REDIS_URL` is absent → `FatalBootError(REDIS_UNAVAILABLE)`
   with context noting the variable is missing. Otherwise an `ioredis` client
   configured to **fail fast, not hang** — `lazyConnect: true`,
   `connectTimeout = REDIS_CONNECT_TIMEOUT_MS`, `maxRetriesPerRequest: 1`, and a
   `retryStrategy` returning `null` (give up) so an unreachable Redis **exits**
   instead of reconnecting forever. Runs `PING`, then `quit`. Failure or timeout →
   `FatalBootError(REDIS_UNAVAILABLE)`.

Because the store URLs are readiness-owned (§3), **both** the missing-var and
unreachable cases resolve to the dependency-specific code, never
`CONFIG_MISSING_OR_INVALID`. Postgres is checked first, then Redis. On a
`FatalBootError` the function calls `failBoot(...)`. Clients and the `exit` hook are
injectable via `deps`, mirroring `loadConfig`, so unit tests assert the right code
and exit with **no live servers**.

This is the function every entrypoint calls at boot — the mechanism behind the
"remove Redis → worker exits with `REDIS_UNAVAILABLE`" QA.

## 7. Migration runner

**`src/scripts/migrate.ts`** — placed **under `src/`** so `tsc -p tsconfig.build.json`
(which has `rootDir: "src"`, `include: ["src/**/*.ts"]`) emits it to
`dist/scripts/migrate.js`. No `tsx` or extra runtime loader is needed; the compiled
JS runs under plain `node` in Railway after the build step. Exposed as npm scripts:

- `npm run db:migrate` → `node dist/scripts/migrate.js up` — runs all pending
  migrations (`direction: 'up'`, count all). This is the Railway `preDeployCommand`.
- `npm run db:migrate:down` → `node dist/scripts/migrate.js down` — single-step
  rollback (`direction: 'down'`, count 1), present because the convention requires
  every migration to have a down even though none exist yet.

Implementation calls node-pg-migrate's **programmatic runner** (the `runner` **named**
export in v8.0.4) with `databaseUrl = DATABASE_URL`, `dir = migrations/`, and
`direction`/`count` as above. node-pg-migrate 8.0.4 exposes **no `advisoryLockMode`**
— its advisory lock is non-blocking (`pg_try_advisory_lock`), with no wait mode — so
concurrent pre-deploy runs cannot serialize. Concurrency is therefore handled at the
deploy topology: the `preDeployCommand` runs on the **worker service only** (§9), so
no two migration runs race. If `DATABASE_URL` is absent at migrate time the runner
exits `MIGRATION_FAILED` with context noting the missing var (migrations cannot run
without a target).

- Success → log applied count, exit 0.
- Any failure → `failBoot(logger, FatalBootError(MIGRATION_FAILED, ...), exit)`,
  non-zero exit → **Railway fails the deploy**.

`migrations/` ships with a `.gitkeep` and a short README. No schema migrations in
0.3 (Task 1.1). An empty `up` run succeeds (nothing pending), proving the runner
end to end.

## 8. Service entrypoints

**`src/services/{webhook-receiver,worker,reconciliation-cron,retention-cron}.ts`** —
each identical in shape:

```
loadConfig() → assertDependenciesReady(config) → log "<service> booted"
```

- **webhook-receiver, worker:** long-running — after boot they `await keepAlive()`.
  Without an event-loop task a bare "log and return" would let Node drain the loop
  and **exit cleanly**, which Railway would treat as a completed process. `keepAlive()`
  (`src/boot/keepalive.ts`) is a **signal-aware, never-resolving promise**: it
  resolves only on `SIGTERM`/`SIGINT` (so Railway can stop the service gracefully),
  otherwise it holds the process open until real work lands in Task 2.x. No busy
  loop — it parks on the signal handlers, not a timer.
- **reconciliation-cron, retention-cron:** run readiness, log, exit 0 (Railway
  re-invokes on schedule). They do **not** call `keepAlive()` — a cron must terminate.
- Each binds a `service` field on its logger so log lines distinguish the four. No
  business logic anywhere.

**webhook-receiver has no HTTP listener in 0.3.** No `healthcheckPath` is configured,
so the deploy succeeds as soon as the process boots and stays up. Its public domain
will return **502 until Task 2.1** adds the real receiver (and Task 2.3 the shared
hardening/auth middleware). This is expected and documented, not a regression — 0.3
is infrastructure only.

`src/index.ts` is left as the current generic boot; it is not repurposed.

## 9. Railway deploy config

`deploy/railway/<service>.json`, one per service. Shared: **`build.builder` is
omitted** (relies on Railway's default builder, Railpack — `NIXPACKS` is no longer a
listed value); `deploy.preDeployCommand = ["npm run db:migrate"]` (array form, per
the current config-as-code reference).

| Service | startCommand | Extra |
| --- | --- | --- |
| webhook-receiver | `node dist/services/webhook-receiver.js` | public domain (dashboard); **no `healthcheckPath`** in 0.3 |
| worker | `node dist/services/worker.js` | `restartPolicyType: "ON_FAILURE"`; no public domain |
| reconciliation-cron | `node dist/services/reconciliation-cron.js` | `cronSchedule: "*/15 * * * *"` |
| retention-cron | `node dist/services/retention-cron.js` | `cronSchedule: "0 4 * * *"` |

All cron schedules are UTC. `deploy/railway/README.md` documents the by-hand
dashboard steps from the build plan: point each service at its config path; wire
`DATABASE_URL` and `REDIS_URL` as reference variables; private networking only; the
worker has no public domain; Postgres PITR and Redis persistence on.

## 10. Testing

- **Unit — readiness** (`test/readiness.test.ts`): injected fake PG/Redis clients.
  Covers four paths per store — missing URL, unreachable/timeout, and success —
  asserting the missing-URL and unreachable cases both exit with
  `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` (never `CONFIG_MISSING_OR_INVALID`)
  and that `exit(1)` fired; the all-reachable path makes no exit call. This is where
  the **"worker with no `REDIS_URL` exits `REDIS_UNAVAILABLE`"** 0.3 QA is pinned as
  a test. Mirrors `test/config.test.ts`.
- **Unit — migrate wrapper** (`test/migrate.test.ts`): injected runner that throws →
  asserts `MIGRATION_FAILED` + non-zero exit; success → exit 0; missing
  `DATABASE_URL` → `MIGRATION_FAILED`. Also asserts the runner is invoked with
  `advisoryLockMode: 'wait'` (regression guard for the concurrent-pre-deploy lock
  behavior).
- **Unit — codes** (`test/boot-codes.test.ts`): `FatalBootError` sanitized context
  carries host/port/db but **never** the credentials from a connection string —
  regression guard against leaking `DATABASE_URL`/`REDIS_URL`. Plus a `failBoot`
  **flush-order** test: a logger stub records when `flush` fires relative to the
  injected `exit`, asserting flush runs **before** exit.
- **Unit — keepalive** (`test/keepalive.test.ts`): `keepAlive()` stays pending until
  a `SIGTERM`/`SIGINT` (simulated via the injected signal source), then resolves —
  proving the long-running services neither exit early nor ignore shutdown signals.
- **Update — `test/config.test.ts`**: `DATABASE_URL` is no longer required at the
  config layer, so the existing "missing `DATABASE_URL` → `CONFIG_MISSING_OR_INVALID`"
  case is **re-pointed to a still-required var** (`NODE_ENV`) to preserve the
  "names the missing var" coverage; the missing-store-URL behavior now lives in the
  readiness test above. The multi-missing test already covers `NODE_ENV`.
- **Build/clean-checkout note**: `npm run build` must emit `dist/scripts/migrate.js`
  (verified by the build step in the verification gate), so that `npm run db:migrate`
  resolves on a fresh Railway checkout after build. Live Postgres/Redis integration
  and the actual concurrent-lock behavior stay **manual**, per the build plan's
  deploy QA. Everything else CI-testable is covered via DI; no testcontainers in 0.3.

## 11. Verification gate (before PR)

`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`,
`npm run format:check`, and `npm audit --audit-level=high` all pass. PR opened into
`main` on branch `task/0.3-railway-deploy`.
