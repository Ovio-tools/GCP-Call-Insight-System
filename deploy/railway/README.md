# Railway deploy config

One config file per service. In the Railway dashboard, set each service's
**Config-as-code path** to its file here (e.g. `deploy/railway/worker.json`).

## Services

| Service             | Config                     | Public domain   | Schedule           |
| ------------------- | -------------------------- | --------------- | ------------------ |
| webhook-receiver    | `webhook-receiver.json`    | yes (dashboard) | —                  |
| worker              | `worker.json`              | **no**          | —                  |
| reconciliation-cron | `reconciliation-cron.json` | no              | `*/15 * * * *` UTC |
| retention-cron      | `retention-cron.json`      | no              | `0 4 * * *` UTC    |
| evaluation-cron     | `evaluation-cron.json`     | no              | `0 6 * * 1` UTC    |

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
