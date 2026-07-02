# CLAUDE.md — call-insight pipeline

Call-processing pipeline that ingests Dialpad calls, redacts them, runs staged
model steps, and exposes authenticated internal surfaces. This file documents the
architecture, data stores, pipeline stages, the operational failure model, and
every engineering convention. Conventions are load-bearing — plan mode reads this
file, so it shapes every plan and every task. The authoritative source is the build
plan (`gcp-call-insight-execution-plan-v8.md`, §2 and §3); this is its working
summary.

Several conventions reference modules not yet built (Task 2.3 hardening/auth
middleware, Task 8.2 crypto/restore procedures, §6.1 held-call retention). When you
implement those, wire them in here rather than rolling your own. The Task 2.2 failure
model now exists under `src/failure-model/` — the canonical home the forerunner error
modules (`src/config`, `src/boot/codes.ts`, `src/db/errors.ts`) and the
`SEAM(Task 2.2)` worker shims (`src/worker/errors.ts`, `src/worker/dead-letter.ts`)
fold into when their code paths are next edited. The Task 2.3 shared hardening/auth
middleware now exists under `src/http/` — every HTTP surface builds on its
`createInternalApp` / `createWebhookApp` factories (see `docs/http-middleware.md`); no
surface rolls its own body limit, rate limiting, auth/session, CSRF, webhook signature/
replay/timestamp checks, or error shaping.

Current repo state: the config loader, logger, data-access layer (Task 1.2), queue +
per-call worker skeleton (Task 2.1), the shared failure model (Task 2.2), the shared
HTTP hardening/auth middleware (Task 2.3), and the metadata pre-filter stage (Task 3.1)
exist; the remaining model steps, surfaces, and crons do not yet.

## 1. Architecture

### 1.1 Components

- **Webhook receiver** (Railway web service, public domain): receives Dialpad call
  events, applies shared hardening and signature checks, stores a minimized raw
  event, enqueues a job, returns 200 fast. Later also receives ServiceTitan
  `job.created`.
- **Worker** (Railway service, always on): consumes the BullMQ/Redis queue and runs
  each call through the pipeline state machine. Pings its own external check.
- **Reconciliation cron** (every 15 min, UTC): lists recently concluded calls and
  enqueues any the webhook missed. Pings its own external check.
- **Retention cron** (daily, UTC): purges rows marked retention-eligible after their
  windows pass. Deletion lives here, never in the per-call path.
- **Review surface** (authenticated internal): where a person resolves held calls.
- **Status surface** (authenticated, mobile-friendly): health and counts per stage
  and component. No content, no PII, no live per-call animation.
- **Knowledge-base surface** (authenticated, read-only): search, export, and
  plain-language summaries over the structured store.
- **Shared failure-model modules** (Task 2.2) and **shared hardening/auth
  middleware** (Task 2.3): used by every stage and surface for consistent error
  handling and endpoint protection.
- **Postgres**: all stores. **Redis**: queue backend. **External monitor**:
  per-component dead-man's switches, plus a backfill check used only during a
  backfill run.

### 1.2 The privacy boundary

Only redacted text crosses to the Anthropic API. Raw transcripts, the token vault,
and recordings never leave Railway — a hard line with tests that assert it. Two
extra checks back it up: a residual-PII scan over the redacted text before it is
sent, and a second PII scan over any extracted verbatim `customer_language` phrases
before they are stored.

## 2. Data stores

All stores are Postgres; Redis backs the queue. Every **purgeable** table carries
the same retention bookkeeping: `retention_eligible_at`, `soft_deleted_at`,
`hard_deleted_at`. The vault and raw transcripts are envelope-encrypted; redaction
findings store hashes or token references, never raw PII in clear. Sensitive values
are minimized in logs, dead-letter rows, and raw webhook events.

| Table                  | Contents                                                                 | Sensitivity | Retention                                  |
| ---------------------- | ------------------------------------------------------------------------ | ----------- | ------------------------------------------ |
| `call_state`           | per-call status, current stage, metadata, drop_reason (set when skipped) | low         | indefinite (not purged)                    |
| `raw_webhook_events`   | allowlisted metadata only; phone/name hashed; no message content         | low–medium  | short, purgeable                           |
| `raw_transcripts`      | original transcript text, envelope-encrypted                             | high        | short, purged after window                 |
| `token_vault`          | token→value map, envelope-encrypted; restricted role only                | highest     | tight access, purged with raw              |
| `clean_transcripts`    | redacted text, risk score, reasons                                       | medium      | kept for re-runs, purgeable                |
| `redaction_findings`   | detected entities + residual-scan results; no raw values in clear        | medium      | purged with the clean transcript           |
| `structured_knowledge` | extracted records, schema + prompt version                               | medium      | the durable asset                          |
| `review_queue`         | held calls, held reason, status, assignee, SLA timestamps                | medium      | held-call retention policy (§6.1)          |
| `operator_actions`     | who did what in the review surface (audit trail)                         | low         | indefinite                                 |
| `model_invocations`    | per call: model ID, prompt version, token counts, outcome                | low         | indefinite                                 |
| `daily_cost_usage`     | per-day token and cost totals                                            | low         | indefinite                                 |
| `alert_events`         | emitted alerts with error code and dedup key                             | low         | indefinite                                 |
| `backfill_runs`        | backfill batches and checkpoints                                         | low         | indefinite                                 |
| `match_keys`           | salted HMAC hashes of phone/name for ServiceTitan matching               | medium      | short, own window, purgeable               |
| `consent_gates`        | recorded consents and legal gates with timestamps                        | low         | indefinite                                 |
| `key_versions`         | DEK metadata + reference only (no recoverable key bytes)                 | low–medium  | indefinite metadata; key material external |
| `processing_log`       | per-stage audit trail with call ID                                       | low         | indefinite                                 |
| `dead_letter`          | jobs that exhausted retries, with sanitized root-cause metadata          | low         | indefinite until cleared                   |

## 3. Pipeline stages (per-call state machine)

```
webhook or list  ->  metadata pre-filter  ->  fetch transcript  ->  transcript availability check
   ->  redact (risk-scored, fail closed)  ->  classify  ->  extract  ->  second PII scan on verbatim phrases
   ->  store  ->  mark retention-eligible
```

- **metadata pre-filter** — runs first, on call metadata only (direction, duration,
  call state, related-call graph). No text, no model, no PII, no transcript fetch.
  Drops obvious junk before a transcript is pulled: a drop sets `status='skipped'` and a
  specific `call_state.drop_reason` (`zero_duration`, `non_conversation_call_state`,
  `outbound_no_customer_conversation`, `internal_transfer_non_operator_leg`), writes a
  `processing_log` row, and stops the pipeline before fetch-transcript. The call and its
  metadata are never deleted. Fails safe: anything missing, unknown, or ambiguous passes.
- **fetch transcript** — only for calls that survive the pre-filter. A call with no
  transcript yet is handled by the availability check, not treated as a failure.
- **redact** — produces redacted text, a token vault, and a risk score with reasons.
  If the residual scan finds anything or the risk score is too high, the call is
  held with reason `redaction_failed` and never sent.
- **classify** (Haiku) — sorts into customer, non-customer, spam, or held. Held and
  spam are set aside, never silently dropped.
- **extract** (Sonnet) — returns a structured record against a fixed schema. A
  schema-validation gate rejects malformed output. A deterministic rule sets the
  urgency flag. Sentiment is internal only.
- **second PII scan** — over the verbatim `customer_language` phrases. A hit holds
  the record rather than storing leaked text.
- **store / mark retention-eligible** — writes the de-identified record, then stamps
  the raw transcript and vault rows with `retention_eligible_at`. The retention cron
  deletes them later.

Every stage that ends in a hold writes a `review_queue` row with a specific reason.
Every model call writes a `model_invocations` row with the model ID and prompt
version.

## 4. Operational failure model (implemented in `src/failure-model/`, Task 2.2)

**Error object.** Every failure produces a structured error object with these
fields:

- `error_code` — stable code, e.g. `DIALPAD_RATE_LIMITED`.
- `root_cause_category` — one of the categories below.
- `severity` — `critical` | `high` | `medium` | `low`.
- `impact` — human-readable business/customer impact, no jargon.
- `processing_state` — `paused` | `degraded` | `continuing`.
- `remediation_now` — immediate step to take.
- `remediation_fix` — longer-term fix if different.
- `data_safe` — whether customer data is safe.
- `calls_state` — whether calls are being held, retried, or dropped.
- `owner` — who is paged / who acts.
- `runbook_ref` — pointer to the runbook section.
- `context` — affected `call_id`, `job_id`, or environment when applicable. **Never
  transcript content or PII.**

**Root-cause categories.** Every failure maps to exactly one:
`CONFIG_MISSING_OR_INVALID`, `DATABASE_UNAVAILABLE`, `REDIS_UNAVAILABLE`,
`MIGRATION_FAILED`, `DIALPAD_AUTH_FAILED`, `DIALPAD_RATE_LIMITED`,
`DIALPAD_API_CHANGED`, `DIALPAD_TRANSCRIPT_MISSING`, `WEBHOOK_SIGNATURE_INVALID`,
`WEBHOOK_REPLAY_DETECTED`, `REDACTION_RECALL_REGRESSION`, `REDACTION_LOW_CONFIDENCE`,
`MODEL_AUTH_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_MALFORMED_RESPONSE`,
`MODEL_COST_CAP_EXCEEDED`, `QUEUE_RETRY_EXHAUSTED`, `DEAD_LETTER_CREATED`,
`RETENTION_PURGE_FAILED`, `BACKFILL_CHECKPOINT_FAILED`, `REVIEW_QUEUE_STALLED`,
`SERVICETITAN_AUTH_FAILED`, `SERVICETITAN_MATCH_WEAK`, `SERVICETITAN_WRITE_FAILED`,
`REQUEST_BODY_TOO_LARGE`, `REQUEST_MALFORMED`, `UNSUPPORTED_MEDIA_TYPE`,
`RATE_LIMIT_EXCEEDED`, `AUTH_REQUIRED`, `CSRF_TOKEN_INVALID`, `WEBHOOK_TIMESTAMP_INVALID`,
`INTERNAL_ERROR` (the last eight added by the Task 2.3 shared hardening/auth middleware).

> The config loader in this scaffold already emits `CONFIG_MISSING_OR_INVALID` and
> names the offending variable; it is the first member of this taxonomy.

**Alert contract.** Every alert reaching OVIO or the status surface states, in plain
words: what broke, the likely root cause, the customer/business impact, the
immediate remediation, the longer-term fix if different, whether data is safe,
whether calls are held/retried/dropped, a runbook pointer, and the timestamp and
environment. No transcript content or PII.

**Behavior.** Alerts are deduplicated by a dedup key during a repeated failure.
Critical alerts escalate if not acknowledged within a configured window. Each major
failure path emits exactly one actionable alert, not a vague trace. Dead-letter rows
carry sanitized root-cause metadata so the dead-letter queue is itself diagnosable.

## 5. Conventions (build plan §3)

**Language/runtime** — Node.js + TypeScript strict mode. Runtime validation at every
boundary with zod.

**Config** — 12-factor; configuration from environment variables only. A zod schema
validates at boot; the process exits with `CONFIG_MISSING_OR_INVALID` that **names
the missing value**. Keep `.env.example` current — schema and example change
together. No secrets in the repo.

**Logging** — structured JSON via pino. A `call_id` flows through every stage. No
transcript content or PII in any log line, ever; the redaction guard refuses to log
known content fields.

**Errors and alerts** — every failure uses the shared failure-model modules (Task
2.2). No silent catches. No bare stack traces as alerts.

**Public surfaces** — every public or internal HTTP surface uses the shared
hardening and auth middleware (Task 2.3). No surface rolls its own.

**Idempotency** — every queue job and every external write carries an idempotency
key. Re-running a job updates, never duplicates.

**Migrations** — every migration has an up and a down. No destructive migration
without a backup step. Schema changes go through plan mode.

**Reversibility / non-destruction** — actions are reversible and additive. Deletes
are soft first. Purge is a scheduled job with a grace window and a dry-run, never
inline in the per-call path. Held calls have bounded retention (§6.1), not
indefinite raw retention.

**Encryption** — `token_vault` and `raw_transcripts` use envelope encryption.
Per-version DEKs are wrapped by a versioned KEK. Wrapped DEK material and the KEK
live in an external secret/key store that is **not** part of Postgres backups. The
`key_versions` table holds only metadata and a reference, never recoverable key
bytes. `key_version` is recorded on every encrypted row. Rotation re-encrypts under
a new DEK and destroys the old DEK material once re-encryption completes. Emergency
revocation destroys the target DEK material or a KEK version, rendering affected
rows unreadable everywhere including restored backups (the backup never contained
the key material — crypto-shredding). Procedures: Task 8.2.

**Model calls** — model IDs are configurable, never hardcoded. Every invocation
records model ID and prompt version in `model_invocations`.

**Secrets** — gitleaks runs as a pre-commit hook and in CI. Least-privilege scopes.
A separate key per environment. A documented secret-rotation procedure.

**CI** — lint, typecheck, test, and build on every pull request. Branch protection
requires green CI and a review before merge. `npm audit` and Dependabot watch
dependencies.

**Fail safe** — when unsure, hold. Never write wrong or guessed data into a real
system.

**Authentication** — every internal surface (status, review, knowledge base)
requires login via the shared middleware. No anonymous access. No PII in any public
response.

**Tests** — unit for pure logic; integration for the database and queue with
external APIs mocked; contract for Dialpad and Anthropic; golden fixtures for model
steps; privacy tests for no-PII-egress and corpus recall; adversarial tests for
redaction and prompt injection; security tests for the public endpoints.

**Environments** — dev, staging, prod are separate. Dev and staging never run on
unredacted real customer data, except the single consented staging validation
(Task 11.1).

**Feature flags** — the model steps and any write-back sit behind flags with a kill
switch.

**Decision records** — short ADR files capture load-bearing choices: match on job
creation, no confidence scores written, sentiment internal only, hashed match keys,
per-component heartbeats, envelope-encryption crypto-shredding.

## 6. Developer workflow

- Install: `npm ci`. Local secret scanning needs `gitleaks` (`brew install
gitleaks`); `npm run prepare` installs the pre-commit hook.
- Scripts: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`,
  `npm run format`.
- All four (lint, typecheck, test, build) must pass; CI enforces them on every PR.
- The build plan (`gcp-call-insight-execution-plan-v8.md`) is the source of truth;
  it is excluded from `prettier` via `.prettierignore` so spec formatting stays
  stable.

## 7. Git workflow

- Never push directly to `main`.
- Each build-plan task gets its own branch and pull request.
- Name branches `task/<id>-<slug>` after the build-plan task, e.g.
  `task/0.2-scaffold`, `task/1.1-schema`.
- Before opening a PR, run `npm run lint`, `npm run typecheck`, `npm run test`,
  `npm run build`, `npm run format:check`, and `npm audit --audit-level=high`.
- Open PRs into `main`; merge only after review and green CI.
- Do not add, remove, or change git remotes unless explicitly instructed.
