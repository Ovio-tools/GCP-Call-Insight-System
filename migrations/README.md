# migrations

node-pg-migrate migration files live here. **Empty in Task 0.3** — the actual schema
and reversible migrations are Task 1.1. `npm run db:migrate` (run as the Railway
pre-deploy command) applies every pending migration in this directory; an empty
directory is a valid no-op run. Every migration must have an `up` and a `down`.
