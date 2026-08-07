# Railway deploy config

One config file per service. In the Railway dashboard, set each service's
**Config-as-code path** to its file here (e.g. `deploy/railway/worker.json`).

The per-release deployment procedure (deploy order, verification, one-offs,
rollback) is [`docs/deployment.md`](../../docs/deployment.md).

## Services

| Service             | Config                     | Public domain   | Schedule                   |
| ------------------- | -------------------------- | --------------- | -------------------------- |
| webhook-receiver    | `webhook-receiver.json`    | yes (dashboard) | —                          |
| worker              | `worker.json`              | **no**          | —                          |
| reconciliation-cron | `reconciliation-cron.json` | no              | `*/15 * * * *` UTC         |
| retention-cron      | `retention-cron.json`      | no              | `0 4 * * *` UTC            |
| evaluation-cron     | `evaluation-cron.json`     | no              | `0 6 * * 1` UTC            |
| sample-validation   | `sample-validation.json`   | no              | on-demand (Task 11.1 demo) |
| console-surface     | `console-surface.json`     | yes (dashboard) | —                          |
| status-surface      | `status-surface.json`      | yes (dashboard) | —                          |
| knowledge-surface   | `knowledge-surface.json`   | yes (dashboard) | —                          |
| review-surface      | `review-surface.json`      | yes (dashboard) | —                          |

The **console-surface** is the single sign-in entry point: it mounts the home page (`GET /`) plus
the status, knowledge-base, and review routes on ONE service under ONE session, so a user signs in
once and reaches every screen from the home page. Prefer it over standing up the three single-surface
services separately (they exist for isolated deploys and stay valid, but each is its own domain and
its own login). Because it includes the review surface, it needs the review-only variables —
`RAW_DATABASE_URL`, the crypto key variables, `REVIEW_ELEVATED_ROLE`, and
`REVIEW_HELD_RAW_RETENTION_CAP_HOURS` — on top of the shared internal-surface set. See
[`docs/console-surface.md`](../../docs/console-surface.md).

The **sample-validation** service is NOT part of the live pipeline — it is the consented,
staging-only demo job (Task 11.1), the one sanctioned way to run **real** Dialpad calls through
the full pipeline in staging (plan §0.2). For a client demo, deploy Postgres + Redis + this job
**instead of** the live services; the full end-to-end runbook is
[`docs/demo-sample-validation-railway.md`](../../docs/demo-sample-validation-railway.md). It has
prerequisites the live services do not: a persistent volume for the file keystore, a one-time key
bootstrap on that volume, and the five §0.2 consent gates recorded in `consent_gates`. Its own
`preDeployCommand` runs migrations (it owns the schema in a demo where no worker is deployed), and
`restartPolicyType: NEVER` makes it a run-to-completion job — you "trigger" a run by redeploying /
restarting the service, and the PII-free report prints to the service logs.

## One-off: generate technician notes for a set of service categories

`technician-notes-dry-run.json` and `technician-notes.json` run the ADR 0009 note batch generator
as a one-off, scoped to the categories named in `TECHNICIAN_NOTE_CATEGORIES` (comma-separated, e.g.
`grinder_pump,water_heater`). A scoped run is how a note prompt gets tried on one slice of the
corpus before the model budget is spent on all of it; an unknown category name is refused before
the job touches config, a pool, or the model, so "0 eligible" always means the corpus and never a
typo. Leaving the variable unset fails the same way rather than quietly noting everything.

Run the dry-run config FIRST — it counts eligible / no-transcript calls with zero model calls, zero
writes, and zero pings — then swap to `technician-notes.json` for the real pass. The real run needs
`TECHNICIAN_NOTES_ENABLED=true`, `TECHNICIAN_NOTES_CHECK_URL`, the alert webhook, and the Anthropic
key; the dry run needs none of those. It is not a pipeline stage: a failure never holds a call, and
a re-run picks up whatever is missing (calls already noted at the current prompt version are
skipped). Afterwards, restore the borrowed service's config path.

## One-off: re-home file-keystore keys into the worker's Railway secrets

`rehome-keys.json` + `rehome-keys.cjs` are a **one-off** migration for an environment first set up
with the `keystore` provider (keys on the `sample-validation` volume) that is moving the worker to
the `railway` key provider. To run it: point the **sample-validation** service's config-as-code path
at `deploy/railway/rehome-keys.json` and redeploy (that service mounts the keystore volume). It reads
`/data/keystore/kek/kek-1.key` + `/data/keystore/dek/1.key`, writes `CRYPTO_KEK_MATERIAL` /
`CRYPTO_WRAPPED_DEK_MATERIAL` to the worker via Railway's API, and exits — printing only success to the
deploy logs, never key bytes. Needs `REHOME_TOKEN` (a Railway account API token) set on the service.
Afterward, restore sample-validation's config path to `sample-validation.json` and delete the token.

## By-hand dashboard steps (build plan Task 0.3)

- Add Postgres and Redis. Turn on Postgres point-in-time recovery and Redis
  persistence. Record the PITR retention window (matters for the deletion promise).
- Wire `DATABASE_URL` and `REDIS_URL` into every service as reference variables.
  These are validated by the **boot readiness check**, not the config loader: an
  absent or unreachable store makes the service exit with `DATABASE_UNAVAILABLE` /
  `REDIS_UNAVAILABLE` (not `CONFIG_MISSING_OR_INVALID`). Debug a crashed deploy by
  looking for those store-specific codes.
- Private networking only: neither Postgres nor Redis has a public endpoint.
- The worker has no public domain.
- The **evaluation-cron** (Task 6.3) runs the weekly accuracy check. Point a service at
  `evaluation-cron.json`. It requires `EVALUATION_CHECK_URL` (its own dead-man's switch),
  `EVALUATION_RUN_ENABLED=true`, and `EVALUATION_LIVE_MODE=true` in staging/production — an enabled
  non-live config fails fast with `CONFIG_MISSING_OR_INVALID`. It records `model_invocations` and
  honors the daily cost cap / kill switches like the worker's model stages.
- Migrations run pre-deploy on the **worker service only** (`npm run db:migrate`).
  node-pg-migrate 8.0.4 has no wait-lock mode (its advisory lock is non-blocking), so
  running migrations from a single service avoids concurrent pre-deploy runs that would
  otherwise fail deploys. If you later need another service to guarantee schema currency
  before boot, gate it on the worker deploy rather than adding a second `preDeployCommand`.

## Known-and-expected in Task 0.3

- `webhook-receiver` has **no HTTP listener yet** (no `healthcheckPath`). Its public
  domain returns 502 until Task 2.1 adds the receiver and Task 2.3 the hardening/auth
  middleware. The deploy still succeeds because the process boots and stays up.
- `migrations/` is empty until Task 1.1, so `db:migrate` is a successful no-op.
