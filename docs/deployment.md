# Manual deployment runbook (Railway)

How code actually reaches production. This repo is **not** connected to Railway's
GitHub auto-deploy: every deployment is a manual push of the local checkout via the
Railway CLI. This document is the ordered release procedure reconstructed from the
config-as-code files (`deploy/railway/*.json`), the Railway deployment history, and
the per-task docs it links to. The service map and one-time dashboard setup live in
[`deploy/railway/README.md`](../deploy/railway/README.md); this file covers the
per-release sequence.

## How a deploy works

- Each Railway service points at its config-as-code file
  (`deploy/railway/<service>.json`) via the dashboard's **Config-as-code path**.
  That file defines the build command, start command, pre-deploy command, restart
  policy, and (for crons) the schedule.
- A deploy is triggered from a local checkout with the Railway CLI: `railway up`
  uploads a snapshot of the working directory, and Railway builds it (Railpack /
  Nixpacks Node builder — there is no Dockerfile). Build logs confirm this:
  deployments start from a "fetched snapshot … unpacking archive", not a git clone.
- Because the snapshot is the **local working directory**, always deploy from a
  clean, up-to-date `main` checkout. Deploying from a feature branch or a dirty
  tree ships unreviewed code.

## Prerequisites

- Railway CLI installed (`brew install railway`) and logged in (`railway login`,
  verify with `railway whoami`).
- The repo directory linked to the project (`railway link` →
  project `gcp-call-insights`; pick the target environment).
- The PR(s) being released are merged to `main` with green CI.

## Standard release sequence

1. **Sync the checkout**

   ```sh
   git checkout main && git pull
   ```

2. **Deploy the worker first**

   ```sh
   railway up --service worker
   ```

   The worker is the **only** service with a migration pre-deploy step
   (`preDeployCommand: npm run db:migrate` → `dist/scripts/migrate.js up`). It
   applies `migrations/` against DB-A (`DATABASE_URL`) first, then
   `migrations-raw/` against DB-B (`RAW_DATABASE_URL`). A migration failure emits
   `MIGRATION_FAILED`, exits non-zero, and fails the deploy — the old worker keeps
   running. Migrations run from the worker only because node-pg-migrate's advisory
   lock is non-blocking: a second concurrent pre-deploy would fail the deploy
   rather than wait.

3. **Verify the worker** before deploying anything that depends on the new schema:
   - `railway logs --service worker` — boots past readiness (no
     `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` / `CONFIG_MISSING_OR_INVALID`).
   - The worker's external heartbeat check (`WORKER_CHECK_URL`) is green
     (see [`heartbeats.md`](heartbeats.md)).

4. **Deploy the other affected services**, one `railway up --service <name>` each.
   Only services whose code or schema expectations changed need a redeploy, but
   after a schema migration every service that reads the changed tables should be
   redeployed in the same release. Current live set (dev environment): `worker`,
   `reconciliation-cron`, `console-surface` (+ `sample-validation` on demand).
   The full roster is the table in
   [`deploy/railway/README.md`](../deploy/railway/README.md).

5. **Verify each service**
   - Long-running services (`worker`, surfaces, `webhook-receiver`): Online in
     `railway status`, logs clean, public URL loads and requires login.
   - Crons (`reconciliation-cron`, `retention-cron`, `evaluation-cron`): they show
     **Completed** (restart policy `NEVER`, run-to-completion) and their external
     check pings green **only after a fully successful run** — a missed check is
     the alert.

6. **Run any post-merge one-off** the release calls for (see below), e.g. a
   backfill or data-fix script that was merged with instructions to run after
   deploy.

## One-off jobs

One-offs (e.g. `reextract`, `reextract-dry-run`, `ack-stale-alerts`,
`rehome-keys`) are run **inside Railway** by config-path swap:

1. In the dashboard, point an existing run-to-completion service (usually
   `sample-validation`) at the one-off's JSON, e.g. `deploy/railway/reextract.json`.
2. Set any variables the job needs, then redeploy (`railway up` or the dashboard
   Redeploy button). `restartPolicyType: NEVER` makes it run once and stop; the
   result prints to the deploy logs.
3. Restore the service's config path to its normal JSON and remove any
   job-specific secrets.

The consented staging demo (`sample-validation`) has its own full runbook:
[`demo-sample-validation-railway.md`](demo-sample-validation-railway.md).

## Rollback

- **Code**: redeploy the previous snapshot from the dashboard (each service keeps
  its deployment history), or `git checkout` the previous `main` commit locally
  and `railway up` again. `railway down` removes the most recent deployment.
- **Schema**: every migration has a down (`npm run db:migrate:down` steps back
  one). Coordinate: roll back the code first, then the migration — never leave a
  service running against a schema older than it expects. Destructive downs
  require a backup step first (see CLAUDE.md migration conventions).

## Environments

`dev`, `staging`, and `prod` are separate Railway environments; `railway link` /
`railway environment` selects the target, and `railway up` deploys into the
currently linked one. Each environment has its own variables, databases (DB-A +
backups-off DB-B), Redis, and heartbeat check URLs. The current running
environment is `dev` (with `NODE_ENV=staging`), running the cron-only launch set.

## Known gaps (to close before a full production launch)

- **Per-service variable manifest** — `.env.example` documents every variable, but
  there is no consolidated list of which variables each of the services requires
  in production.
- **Backup/PITR values** — the required table in
  [`backup-retention.md`](backup-retention.md) (PITR window, snapshot cadence,
  encryption-at-rest) is still `UNKNOWN`; the restore drill fails until filled.
- **`review-surface.json` does not exist** — the README table lists it, but the
  standalone review surface has no config file (the console surface covers it).
- **Deploy gating** — nothing enforces "worker first"; the ordering is this
  document plus discipline.
