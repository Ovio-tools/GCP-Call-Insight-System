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
- A forerunner error module for the three boot-time taxonomy codes.
- A dependency-injected boot readiness check.
- A migration runner (up + down) exposed as npm scripts; the `up` script is the
  Railway pre-deploy command.
- Four thin service entrypoints.
- One committed Railway config file per service, plus a README documenting the
  by-hand dashboard steps.
- Unit tests for the readiness check, the migration wrapper, and the error module.

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
| pre-deploy on which services | **All four** | node-pg-migrate takes a pg advisory lock by default, so concurrent pre-deploy runs serialize safely; each service guarantees the schema is current before it boots. |
| retention-cron schedule | `0 4 * * *` (daily, 04:00 UTC) | Daily as required; off-peak. Trivially changeable. |

## 4. Config and dependencies

**`src/config/schema.ts`** (kept in lockstep with `.env.example`):

- `REDIS_URL: z.string().min(1)` — required. Redis/BullMQ backend.
- `DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — optional.
- `REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — optional.

`.env.example` gains matching entries (required `REDIS_URL`, the two optional
timeouts under the "Optional (defaults shown)" section).

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
  `{ error_code, context }` through the existing pino logger, then `exit(1)`.
  "Exits loudly" = one actionable structured line + non-zero exit; never a bare
  stack trace as the alert.

## 6. Boot readiness check

**`src/boot/readiness.ts`** — `assertDependenciesReady(config, deps?)`:

1. **Postgres:** a `pg.Client` with `connectionTimeoutMillis = DB_CONNECT_TIMEOUT_MS`,
   runs `SELECT 1`, then closes. Failure or timeout → `FatalBootError(DATABASE_UNAVAILABLE)`.
2. **Redis:** an `ioredis` client configured to **fail fast, not hang** —
   `lazyConnect: true`, `connectTimeout = REDIS_CONNECT_TIMEOUT_MS`,
   `maxRetriesPerRequest: 1`, and a `retryStrategy` returning `null` (give up) so a
   missing Redis **exits** instead of reconnecting forever. Runs `PING`, then `quit`.
   Failure or timeout → `FatalBootError(REDIS_UNAVAILABLE)`.

Postgres is checked first, then Redis. On a `FatalBootError` the function calls
`failBoot(...)`. Clients and the `exit` hook are injectable via `deps`, mirroring
`loadConfig`, so unit tests assert the right code and exit with **no live servers**.

This is the function every entrypoint calls at boot — the mechanism behind the
"remove Redis → worker exits with `REDIS_UNAVAILABLE`" QA.

## 7. Migration runner

**`scripts/migrate.ts`**, exposed as npm scripts:

- `npm run db:migrate` → runs all pending migrations (`direction: 'up'`, count all).
  This is the Railway `preDeployCommand`.
- `npm run db:migrate:down` → single-step rollback (`direction: 'down'`, count 1),
  present because the convention requires every migration to have a down even though
  none exist yet.

Implementation calls node-pg-migrate's **programmatic runner** with
`databaseUrl = DATABASE_URL`, `dir = migrations/`, and the direction/count above.
node-pg-migrate takes a **pg advisory lock by default**, so the four services'
concurrent pre-deploy runs serialize rather than collide.

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

- **webhook-receiver, worker:** long-running — stay alive after boot. No HTTP
  server, no queue.
- **reconciliation-cron, retention-cron:** run readiness, log, exit 0 (Railway
  re-invokes on schedule).
- Each binds a `service` field on its logger so log lines distinguish the four. No
  business logic anywhere.

`src/index.ts` is left as the current generic boot; it is not repurposed.

## 9. Railway deploy config

`deploy/railway/<service>.json`, one per service. Shared: `build.builder = "NIXPACKS"`,
`deploy.preDeployCommand = "npm run db:migrate"`.

| Service | startCommand | Extra |
| --- | --- | --- |
| webhook-receiver | `node dist/services/webhook-receiver.js` | public domain (dashboard) |
| worker | `node dist/services/worker.js` | `restartPolicyType: "ON_FAILURE"`; no public domain |
| reconciliation-cron | `node dist/services/reconciliation-cron.js` | `cronSchedule: "*/15 * * * *"` |
| retention-cron | `node dist/services/retention-cron.js` | `cronSchedule: "0 4 * * *"` |

All cron schedules are UTC. `deploy/railway/README.md` documents the by-hand
dashboard steps from the build plan: point each service at its config path; wire
`DATABASE_URL` and `REDIS_URL` as reference variables; private networking only; the
worker has no public domain; Postgres PITR and Redis persistence on.

## 10. Testing

- **Unit — readiness** (`test/readiness.test.ts`): injected fake PG/Redis clients →
  assert `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` and that `exit(1)` fired; the
  success path makes no exit call. Mirrors `test/config.test.ts`.
- **Unit — migrate wrapper** (`test/migrate.test.ts`): injected runner that throws →
  asserts `MIGRATION_FAILED` + non-zero exit; success → exit 0.
- **Unit — codes** (`test/boot-codes.test.ts`): `FatalBootError` sanitized context
  carries host/port/db but **never** the credentials from a connection string —
  regression guard against leaking `DATABASE_URL`/`REDIS_URL`.
- Live Postgres/Redis integration stays **manual**, per the build plan's deploy QA.
  Everything CI-testable is covered via DI; no testcontainers in 0.3.

## 11. Verification gate (before PR)

`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`,
`npm run format:check`, and `npm audit --audit-level=high` all pass. PR opened into
`main` on branch `task/0.3-railway-deploy`.
