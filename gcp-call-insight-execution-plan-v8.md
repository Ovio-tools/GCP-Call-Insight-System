# Good Clean Plumbing call-insight system: build and execution plan (v8)

This is the working plan for building the call-insight system described in the proposal. It is written to be run with Claude Code. Each task carries a copy-paste prompt, a plan-mode flag, its dependencies, what it can run alongside, the tests that prove it is done, and its security notes.

Read section 0 before touching anything. This version incorporates seven rounds of architecture review. The rounds are summarized in sections 9 through 15.

---

## 0. Before you start

### 0.1 What this plan builds

The core build is the pipeline the proposal sells: pull each call from Dialpad, strip personal details, confirm it is a real customer call, pull out structured details, and store them in a knowledge base that Eric owns. First release also delivers two things the proposal implies but the data foundation alone does not provide: a working held-for-review workflow (a person resolves the calls the system is unsure about) and a minimal read-only knowledge-base surface (search, export, plain-language summaries). The richer downstream tools for marketing and customer experience come later and read from the same store.

The ServiceTitan dispatch-summary write-back is in this plan as the final phase, kept separate and gated. It is not part of what the proposal shows Eric, and it does not start until the data-processing addendum is signed, ServiceTitan API access is confirmed, its own matching-key design (section 12.0) is in place, and the ServiceTitan matching consent is recorded. If you want it in the first release, promote it, but do that on purpose, not by accident.

### 0.2 Gates that must clear before live processing

These gates govern live or production processing of real customer data. There is one controlled exception: the consented staging validation in Task 11.1, which runs a small batch of real calls in staging and which itself requires every gate in this section to be recorded first. Outside that one task, use synthetic fixtures for every task up to and including Phase 11.

- Eric has confirmed in writing that the Dialpad calls were recorded properly and he has the right to share them. Record this as a row in `consent_gates`.
- The services agreement and the data-processing addendum are signed and recorded in `consent_gates`. The historical backfill does not start until all section 0.2 processing, legal, and vendor-retention gates are recorded, not the addendum alone.
- The Anthropic API is on terms that do not train on submitted data, confirmed and recorded.
- Anthropic's API data retention policy is confirmed and recorded, not just the no-training terms. At the time of writing, API inputs and outputs are generally deleted within about 30 days, with exceptions. Re-confirm the current policy at build time so the privacy record captures retention alongside training.
- If ServiceTitan write-back is in scope, its separate matching consent is recorded (section 12.0).

### 0.3 Design constraints that override the obvious build

1. The heartbeat lives outside Railway, and each component has its own external check. Railway's cron has known reliability gaps and the platform had networking incidents this year. A heartbeat that runs inside the same Railway project gets stuck alongside the job it is meant to watch. So the dead-man's switch is an external monitor. Critically, the worker, the reconciliation cron, and the retention cron each ping a separate external check on their own cadence. A single shared check would be masked: if the worker keeps pinging, a dead reconciliation cron would never alert. Phase 7 sets up one check slug per component.

2. Redaction fails closed, and it does not claim perfect coverage. On a real call there is no known list of PII, so a single "coverage score" is a false comfort. The redaction stage produces a risk score with reasons, runs a residual-PII scan over its own output, and holds the call if anything looks unsafe. Recall is measured on a labeled synthetic corpus in CI, not asserted on live traffic. Phase 4 builds this.

3. Purge is a scheduled retention job, not a step in the per-call path. The per-call pipeline only marks a row as retention-eligible. A separate scheduled job purges eligible rows after the configured windows. This keeps deletion off the happy path, makes it auditable, and makes a dry-run trivial. Phase 8 builds this.

4. Sensitive data at rest is encrypted with a real key hierarchy, and the key material does not live in the backed-up database. `token_vault` and `raw_transcripts` are encrypted at the application layer using envelope encryption: per-version data keys (DEKs) wrapped by a versioned key-encryption key (KEK). The wrapped DEK material lives in a secret store or key service that is not part of the Postgres backups, never in a Postgres table. The `key_versions` table in Postgres holds only metadata and a reference (key_version, status, a pointer to where the wrapped DEK lives, timestamps), never recoverable key bytes. This is what makes deletion meaningful even when database backups still hold the ciphertext rows. The catch, spelled out in Task 8.2: a backup taken before deletion would also capture the wrapped DEK if it lived in Postgres, and with the KEK still present a restore could decrypt. Keeping the wrapped DEK out of the backed-up database, plus versioned KEKs that can themselves be destroyed, is what makes crypto-shredding actually reach backups. Rotation and emergency revocation must destroy the relevant key material in the external store, or the backup rows stay readable. Phases 1 and 8 cover this.

### 0.4 How to run a task with Claude Code

For each task below:

1. Open a terminal in the repo and start Claude Code with `claude`.
2. If the task says **Plan mode: YES**, press Shift+Tab twice (the footer should read plan mode on) or type `/plan`. Plan mode is read-only: Claude maps the change and shows you a plan before writing anything. Read the plan, push back on anything that looks wrong, then approve. Use it for schema changes, security-sensitive code, and anything touching three or more files.
3. If the task says **Plan mode: NO**, run it directly. These are small, single-file, or low-risk changes where planning overhead is not worth it.
4. Paste the prompt block. Let Claude Code propose, review, approve.
5. Run the task's tests. Do not move on until they pass.
6. Commit the task on its own branch, open a pull request, let CI run, merge. One task, one PR.

Keep `CLAUDE.md` (Task 0.2) current. Plan mode reads it, so the conventions in it directly shape the quality of every plan.

### 0.5 Timeline risk

The proposal shows a 2-week build. That is achievable only if the first release stays narrow. It assumes fast credential access, Dialpad and Anthropic APIs that behave as documented, no surprises in real Dialpad call payloads, a deliberately minimal knowledge-base surface, and no ServiceTitan write-back in the core release. The held-for-review workflow and the public-endpoint hardening are not optional and are costed into the build. If any assumption breaks, the realistic path is to ship the ingest-to-store pipeline plus held-review first, then add the knowledge-base surface, and keep ServiceTitan gated. Treat the 2 weeks as the build bar for a narrow MVP, not for everything in this document.

---

## 1. Services and accounts required

| Service | Who owns the account | Purpose | Security notes |
|---|---|---|---|
| GitHub | OVIO (Eric added as reader on handover) | Source of truth, CI, secret scanning, dependency alerts | Private repo. Branch protection. Required review. No secrets in git, ever. |
| Railway | Eric's Railway organization, OVIO invited as a member | Compute and managed data stores | The project, Postgres, and Redis are provisioned under Eric's org so the "runs in your account, you own it" claim is literally true. OVIO operates it. |
| Railway: Postgres | Eric's Railway org | The knowledge base and all working stores | Encrypted at rest. App-level envelope encryption on the vault and raw transcripts. Restricted roles. Point-in-time recovery on, with a stated retention policy (section 8.2). |
| Railway: Redis | Eric's Railway org | BullMQ queue backend | Private networking only. No public endpoint. Persistence on so queued jobs survive a restart. |
| Anthropic API | OVIO (separate key per environment) | Classify (Haiku) and extract (Sonnet) | No-train terms and data retention policy confirmed and recorded. Key in Railway secrets, never in code. Model IDs configurable. Token budget caps. |
| Dialpad API | Eric's Dialpad account, OVIO-managed app key or OAuth | Source of calls and transcripts | Least-privilege scopes. Webhook secret set so events are JWT-signed. Respect both rate limits (section 3.3). |
| External cron monitor | OVIO | Dead-man's switch, off Railway | One check slug per component (worker, reconciliation cron, retention cron), each on its own cadence, plus a backfill check active only during backfill runs. Alerts OVIO when any one is missed. |
| Alert channel | OVIO (email or SMS or Slack) | Where breakage and cost alerts land | Alerts follow the formatting contract in section 2.7. No PII in alerts. |
| Auth provider for internal surfaces | OVIO | Login for Eric's status page, the review surface, and the knowledge-base surface | All three internal surfaces require authentication through the shared middleware in Task 2.3. No anonymous access. |
| ServiceTitan (gated, final phase) | Eric's ServiceTitan account, OVIO developer app | Dispatch-summary write-back | OAuth2 machine-to-machine, least-privilege scopes. Webhook authentication verified using ServiceTitan's current supported mechanism, confirmed at build time. Needs its own matching consent. |

A note on the ownership claim. The proposal tells Eric the system runs in his account and he owns it. That is only literally true if the Railway organization, Postgres, and Redis are created under Eric's Railway org with OVIO added as a member. Do it that way.

---

## 2. Architecture at a glance

### 2.1 Components

- **Webhook receiver** (Railway web service, public domain): receives Dialpad call events, applies the shared hardening and signature checks, stores a minimized raw event, enqueues a job, returns 200 fast. Later also receives ServiceTitan `job.created` (final phase).
- **Worker** (Railway service, always on): consumes the BullMQ queue and runs each call through the pipeline state machine. Pings its own external check.
- **Reconciliation cron** (Railway cron, every 15 minutes, UTC): lists recently concluded calls from metadata and enqueues any the webhook missed. Pings its own external check.
- **Retention cron** (Railway cron, daily, UTC): purges rows marked retention-eligible after their windows pass. Pings its own external check. Deletion lives here, not in the per-call path.
- **Review surface** (authenticated internal tool): where a person resolves held calls.
- **Status surface** (authenticated, mobile-friendly): where Eric sees health at a glance, as a plain-language summary plus a structure-plus-health view of the pipeline that shows each stage and component's state and the count of calls sitting there. Health and counts only, no content or PII, and no live per-call execution animation.
- **Knowledge-base surface** (authenticated, read-only): search, export, and plain-language summaries over the structured store.
- **Shared failure-model modules** (Task 2.2) and **shared hardening and auth middleware** (Task 2.3): used by every stage and every surface so error handling and endpoint protection are consistent.
- **Postgres**: all stores. **Redis**: queue backend. **External monitor**: per-component dead-man's switches, plus a backfill check used only while a backfill run is active.

### 2.2 The privacy boundary

Only redacted text crosses to the Anthropic API. Raw transcripts, the token vault, and recordings never leave Railway. This is a hard line with tests that assert it. Two extra checks back it up: a residual-PII scan runs over the redacted text before it is sent, and a second PII scan runs over any extracted `customer_language` phrases before they are stored for marketing use, since those are verbatim and are the most likely place a leak survives.

### 2.3 Pipeline state machine (per call)

```
webhook or list  ->  metadata pre-filter  ->  fetch transcript  ->  transcript availability check
   ->  redact (risk-scored, fail closed)  ->  classify  ->  extract  ->  second PII scan on verbatim phrases
   ->  store  ->  mark retention-eligible
```

- **metadata pre-filter** runs first, on call metadata only (direction, duration, call state, the related-call graph). No text, no model, no PII, and crucially no transcript fetch. It drops obvious junk before a transcript is even pulled.
- **fetch transcript** happens only for calls that survive the pre-filter. A call with no transcript yet is handled by the availability check, not treated as a failure.
- **redact** produces redacted text, a token vault, and a risk score with reasons. If the residual scan finds anything or the risk score is too high, the call is held with reason `redaction_failed`, never sent.
- **classify** (Haiku) sorts the call into customer, non-customer, spam, or held. Held and spam are set aside, never silently dropped.
- **extract** (Sonnet) returns a structured record against a fixed schema. A schema-validation gate rejects malformed output. A deterministic rule sets the urgency flag. Sentiment is internal only.
- **second PII scan** runs over the verbatim `customer_language` phrases. A hit holds the record rather than storing leaked text.
- **store** writes the de-identified record. **mark retention-eligible** stamps the raw transcript and vault rows with a `retention_eligible_at` time. The retention cron deletes them later.

Every stage that ends in a hold writes a `review_queue` row with a specific reason. Every model call writes a `model_invocations` row with the model ID and prompt version.

### 2.4 Data stores

Every purgeable table carries the same retention bookkeeping: `retention_eligible_at`, `soft_deleted_at`, and `hard_deleted_at`.

| Table | Contents | Sensitivity | Retention |
|---|---|---|---|
| `call_state` | per-call status, current stage, metadata | low | indefinite |
| `raw_webhook_events` | allowlisted metadata only, phone or name hashed if present, no message content | low to medium | short, purgeable, full retention bookkeeping |
| `raw_transcripts` | original transcript text, envelope-encrypted | high | short, purged after window |
| `token_vault` | token-to-value map, envelope-encrypted | highest | tight access, purged with raw |
| `clean_transcripts` | redacted text, risk score, reasons | medium | kept for re-runs, purgeable with bookkeeping |
| `redaction_findings` | per-call detected entities and residual-scan results, no raw values in clear | medium | purged with the clean transcript, full retention bookkeeping |
| `structured_knowledge` | extracted records, schema and prompt version | medium | the durable asset |
| `review_queue` | held calls, held reason, status, assignee, SLA timestamps | medium | held-call retention policy (section 6.1) |
| `operator_actions` | who did what in the review surface, audit trail | low | indefinite |
| `model_invocations` | per call: model ID, prompt version, token counts, outcome | low | indefinite |
| `daily_cost_usage` | per-day token and cost totals | low | indefinite |
| `alert_events` | emitted alerts with error code and dedup key | low | indefinite |
| `backfill_runs` | backfill batches and checkpoints | low | indefinite |
| `match_keys` | salted HMAC hashes of phone and name for ServiceTitan matching | medium | short, own window, full retention bookkeeping (section 12.0) |
| `consent_gates` | recorded consents and legal gates with timestamps | low | indefinite |
| `key_versions` | DEK metadata and a reference only: key_version, status, pointer to externally stored wrapped DEK, created and destroyed timestamps. No recoverable key bytes. KEK and wrapped DEK material live outside Postgres | low to medium | indefinite metadata, external key material destroyed on revocation |
| `processing_log` | per-stage audit trail with call ID | low | indefinite |
| `dead_letter` | jobs that exhausted retries, with sanitized root-cause metadata | low | indefinite until cleared |

Sensitive values are minimized in logs, dead-letter rows, and raw webhook events. The vault and raw transcripts are envelope-encrypted. Redaction findings store hashes or token references, not raw PII in clear.

### 2.5 Build dependency graph

```mermaid
graph TD
  T02[0.2 Repo scaffold + CLAUDE.md] --> T11[1.1 Schema + migrations]
  T02 --> T22[2.2 Failure-model modules]
  T02 --> T23[2.3 Hardening + auth middleware]
  T22 --> T23
  T03[0.3 Railway provisioning] --> T21[2.1 Queue + worker skeleton]
  T11 --> T12[1.2 Data-access layer]
  T11 --> T21
  T12 --> T31[3.1 Metadata pre-filter]
  T21 --> T31
  T31 --> T32[3.2 Webhook receiver]
  T23 --> T32
  T31 --> T33[3.3 Dialpad transcript client]
  T32 --> T34[3.4 Reconciliation cron]
  T33 --> T34
  T11 --> T41[4.1 Redaction + vault + residual scan]
  T41 --> T51[5.1 Classifier]
  T51 --> T52[5.2 Extractor + verbatim PII scan]
  T52 --> T53[5.3 Store + mark retention-eligible]
  T11 --> T61[6.1 Review queue wiring + held retention]
  T53 --> T61
  T61 --> T62[6.2 Review surface authed]
  T23 --> T62
  T62 --> T63[6.3 Reviewed decisions to fixtures]
  T21 --> T71[7.1 Per-component dead-man switches]
  T21 --> T72[7.2 Cost guardrails]
  T22 --> T73[7.3 Status surface + alert contract]
  T23 --> T73
  T21 --> T73
  T22 --> T74[7.4 Logging, audit, error codes]
  T21 --> T74
  T11 --> T81[8.1 Scheduled retention job]
  T81 --> T82[8.2 Backup + key hierarchy + restore drill]
  T32 --> T91[9.1 Public endpoint security audit]
  T62 --> T91
  T73 --> T91
  T101 --> T91
  T53 --> T101[10.1 Knowledge-base surface]
  T23 --> T101
  T53 --> T111[11.1 Sample validation]
  T111 --> T112[11.2 Historical backfill GATED]
  T53 --> T120[12.0 Matching-key design]
  T120 --> T121[12.1 ServiceTitan write GATED]
```

### 2.6 What can run in parallel

After the foundation (0.2, 0.3, 1.1, 2.2, 2.3) is in place, these streams can be built side by side against synthetic fixtures, then integrated:

| Stream | Tasks | Depends on | Can run alongside |
|---|---|---|---|
| Foundation modules | 2.2, 2.3 | 0.2 | data layer, queue |
| Data layer | 1.1, 1.2 | 0.2 | 2.1 once 1.1 lands |
| Queue and worker | 2.1 | 0.3, 1.1 | data layer, foundation modules |
| Ingestion | 3.1 then 3.2, 3.3, 3.4 | 2.1, 1.2, and 2.3 for 3.2 | redaction, model steps, observability |
| Redaction | 4.1 | 1.1 | ingestion, model steps |
| Model steps | 5.1, 5.2, 5.3 | 4.1 output contract | ingestion, observability |
| Held-for-review | 6.1, 6.2, 6.3 | 1.1, 5.3, and 2.3 for 6.2 | observability, retention |
| Observability | 7.1, 7.2, 7.3, 7.4 | 2.1, 2.2, and 2.3 for 7.3 | everything |
| Retention | 8.1, 8.2 | 1.1 | model steps, observability |
| Knowledge-base surface | 10.1 | 5.3, 2.3 | observability, retention |
| Security audit | 9.1 | 3.2, 6.2, 7.3, 10.1 | runs after the public surfaces exist |

Critical path: 0.2 -> 1.1 -> 2.1 -> 3.1 -> 3.2 -> 3.3 -> 4.1 -> 5.1 -> 5.2 -> 5.3 -> 6.1 -> 6.2. The shared modules 2.2 and 2.3 are early foundation: build them right after 0.2, in parallel with the data layer, because the public surfaces (3.2, 6.2, 7.3, 10.1) and the observability tasks depend on them.

The integration step (wiring the worker to call each stage in order) is where the parallel streams converge. Do it after 3.x, 4.1, and 5.x exist, in its own task with its own end-to-end test.

### 2.7 Operational failure model (specification)

This section is the specification. Task 2.2 turns it into shared code. Every other task emits against it.

**Error code structure.** Every failure produces a structured error object with these fields:

- `error_code`: a stable code, for example `DIALPAD_RATE_LIMITED`.
- `root_cause_category`: one of the categories below.
- `severity`: `critical`, `high`, `medium`, or `low`.
- `impact`: human-readable business or customer impact, no jargon.
- `processing_state`: `paused`, `degraded`, or `continuing`.
- `remediation_now`: the immediate step to take.
- `remediation_fix`: the longer-term fix if different.
- `data_safe`: whether customer data is safe.
- `calls_state`: whether calls are being held, retried, or dropped.
- `owner`: who is paged or who acts.
- `runbook_ref`: a pointer to the runbook section.
- `context`: affected `call_id`, `job_id`, or environment when applicable. Never transcript content or PII.

**Root-cause categories.** Every failure maps to exactly one:

`CONFIG_MISSING_OR_INVALID`, `DATABASE_UNAVAILABLE`, `REDIS_UNAVAILABLE`, `MIGRATION_FAILED`, `DIALPAD_AUTH_FAILED`, `DIALPAD_RATE_LIMITED`, `DIALPAD_API_CHANGED`, `DIALPAD_TRANSCRIPT_MISSING`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_REPLAY_DETECTED`, `REDACTION_RECALL_REGRESSION`, `REDACTION_LOW_CONFIDENCE`, `MODEL_AUTH_FAILED`, `MODEL_RATE_LIMITED`, `MODEL_MALFORMED_RESPONSE`, `MODEL_COST_CAP_EXCEEDED`, `QUEUE_RETRY_EXHAUSTED`, `DEAD_LETTER_CREATED`, `RETENTION_PURGE_FAILED`, `BACKFILL_CHECKPOINT_FAILED`, `REVIEW_QUEUE_STALLED`, `SERVICETITAN_AUTH_FAILED`, `SERVICETITAN_MATCH_WEAK`, `SERVICETITAN_WRITE_FAILED`.

**Alert formatting contract.** Every alert that reaches OVIO or the status surface contains, in plain words: what broke, the likely root cause, the customer or business impact, the immediate remediation, the longer-term fix if different, whether data is safe, whether calls are being held or retried or dropped, a pointer to the runbook, and the timestamp and environment. No transcript content or PII.

**Behavior.** Alerts are deduplicated by a dedup key during a repeated failure. Critical alerts escalate if not acknowledged within a configured window. Each major failure path emits exactly one actionable alert, not a vague trace. Dead-letter rows carry the sanitized root-cause metadata so the dead-letter queue itself is diagnosable.

---

## 3. Conventions and engineering practices

These go in `CLAUDE.md` (Task 0.2) so every plan and every task respects them.

- **Language and runtime**: Node.js with TypeScript in strict mode. Runtime validation at every boundary with zod.
- **Config**: 12-factor. Configuration comes from environment variables only. A schema validates them at boot and the process exits with a `CONFIG_MISSING_OR_INVALID` error that names the missing value. Keep `.env.example` current. No secrets in the repo.
- **Logging**: structured JSON logs with pino. A call ID flows through every stage. No transcript content or PII in any log line, ever.
- **Errors and alerts**: every failure uses the shared failure-model modules from Task 2.2 (error types, alert formatter, dedup keys, severity mapping). No silent catches. No bare stack traces as alerts.
- **Public surfaces**: every public or internal HTTP surface uses the shared hardening and auth middleware from Task 2.3. No surface rolls its own.
- **Idempotency**: every queue job and every external write carries an idempotency key. Re-running a job updates, never duplicates.
- **Migrations**: every migration has an up and a down. No destructive migration without a backup step. Schema changes go through plan mode.
- **Reversibility and non-destruction**: actions are reversible and additive. Deletes are soft first. Purge is a scheduled job with a grace window and a dry-run, never inline in the per-call path. Held calls have a bounded retention policy (section 6.1), not indefinite raw retention.
- **Encryption**: `token_vault` and `raw_transcripts` use envelope encryption. Per-version data keys (DEKs) are wrapped by a versioned key-encryption key (KEK). The wrapped DEK material and the KEK live in a secret store or key service that is not part of the Postgres backups. The `key_versions` table in Postgres holds only metadata and a reference, never recoverable key bytes. `key_version` is recorded on every encrypted row. Rotation re-encrypts under a new DEK and destroys the old DEK material in the external store once re-encryption completes. Emergency revocation destroys the target DEK material or a KEK version in the external store, which renders the affected rows unreadable everywhere, including in any restored backup, because the backup never contained the key material. Procedures are documented in Task 8.2.
- **Model calls**: model IDs are configurable, never hardcoded. Every invocation records the model ID and the prompt version in `model_invocations`.
- **Secrets**: gitleaks runs as a pre-commit hook and in CI. Least-privilege scopes. A separate key per environment. A documented secret-rotation procedure.
- **CI**: lint, typecheck, test, and build on every pull request. Branch protection requires green CI and a review before merge. `npm audit` and Dependabot watch dependencies.
- **Fail safe**: when unsure, hold. Never write wrong or guessed data into a real system.
- **Authentication**: every internal surface (status, review, knowledge base) requires login via the shared middleware. No anonymous access. No PII in any public response.
- **Tests**: unit for pure logic, integration for the database and queue with external APIs mocked, contract for Dialpad and Anthropic, golden fixtures for model steps, privacy tests for no-PII-egress and corpus recall, adversarial tests for redaction and prompt injection, and security tests for the public endpoints.
- **Environments**: dev, staging, prod are separate. Dev and staging never run on unredacted real customer data, except the single consented staging validation in Task 11.1.
- **Feature flags**: the model steps and any write-back sit behind flags with a kill switch.
- **Decision records**: short ADR files capture the load-bearing choices (match on job creation, no confidence scores written, sentiment internal only, hashed match keys, per-component heartbeats, envelope-encryption crypto-shredding).

---

## 4. The build

Each task follows the same shape: plan-mode flag, dependencies, a copy-paste prompt, tests, and security notes.

---

### Phase 0: Foundation

#### Task 0.1: Accounts and access

**Plan mode: N/A** (human checklist, not a Claude Code task)
**Depends on: nothing**

Set these up by hand and record where each credential lives:

- Create the Railway organization under Eric's account. Invite OVIO as a member. Create one project with three environments (dev, staging, prod).
- Create a private GitHub repo. Turn on branch protection, required reviews, and Dependabot.
- Create an Anthropic API key per environment. Confirm and record both the no-training terms and the API data retention terms, capturing the evidence URL, the confirmation date, the selected model IDs, the account or product path the terms apply to, the standard retention window, and any exceptions.
- Create the Dialpad app key or OAuth client with least-privilege scopes (transcript read, recordings_export only if recording URLs are needed). Record both rate limits: 1200 requests per minute on the transcript endpoint and 20 requests per second at the company level. Confirm both against current Dialpad docs.
- Create the external cron-monitor account and four checks. Three are cadence checks, one each for the worker, the reconciliation cron, and the retention cron on their own expected cadences. The fourth is a job-style backfill check configured to expect a start signal, then periodic progress pings, then a terminal success or fail signal. Between runs it is idle by design and must not alert; during a run it alerts if progress stalls or a fail signal arrives or the terminal signal never comes. Most cron-monitoring services support this with start and fail endpoints; pick one that does.
- Choose the auth provider for the internal surfaces and record how login works for Eric and for OVIO reviewers.

Do not proceed until each credential exists and its home is written down.

---

#### Task 0.2: Repo scaffold and CLAUDE.md

**Plan mode: YES.** It creates many files and sets the conventions every later task inherits.
**Depends on: 0.1**
**Parallel with: 0.3**

```text
Set up a new TypeScript Node.js project for a call-processing pipeline. Use strict TypeScript. Add:
- vitest for tests, eslint and prettier, and scripts for lint, typecheck, test, and build.
- pino for structured JSON logging, with a logger that attaches a call_id to every line and a redaction guard that refuses to log known content fields.
- zod for runtime validation, and a config loader that reads all settings from environment variables, validates them at startup, and exits with a CONFIG_MISSING_OR_INVALID error that names the missing value. Keep a .env.example in sync.
- A GitHub Actions workflow that runs lint, typecheck, test, and build on every pull request.
- gitleaks as a pre-commit hook and as a CI step.
- A CLAUDE.md that documents the architecture, the data stores, the pipeline stages, the operational failure model, and every convention in section 3 of the build plan I will paste in. Read it back to me before finalizing.
Do not add business logic yet. Scaffolding only.
Write a test that proves the config loader exits with the named-value error when a required variable is missing.
```

**Tests and QA**
- `npm run lint`, `npm run typecheck`, `npm run build` pass on a clean checkout.
- Config loader test passes: a missing variable causes a clean, named exit.
- The logger redaction guard blocks an attempt to log a content field.
- gitleaks blocks a commit containing a fake secret.

**Security**
- `.env.example` holds names only. `.gitignore` excludes `.env`. Confirm gitleaks catches a planted secret before you trust it.

---

#### Task 0.3: Railway provisioning

**Plan mode: NO** for the dashboard steps. **Plan mode: YES** for the deploy and migration code.
**Depends on: 0.1**
**Parallel with: 0.2**

Dashboard steps (by hand):
- In Eric's Railway org, add Postgres and Redis from the New menu. Turn on point-in-time recovery for Postgres and persistence for Redis. Record the PITR retention window; it matters for the deletion promise (section 8.2).
- Create services: `webhook-receiver` (public domain), `worker` (no public domain), `reconciliation-cron`, `retention-cron`. Wire `DATABASE_URL` and `REDIS_URL` as reference variables. Set `reconciliation-cron` to `*/15 * * * *` and `retention-cron` to a daily schedule (Railway minimum is every 5 minutes, all schedules UTC).
- Set a pre-deploy command that runs migrations before each deploy.

```text
Add a deploy configuration and a migration runner for a Railway project with Postgres and Redis and four services: webhook-receiver, worker, reconciliation-cron, retention-cron. Each reads DATABASE_URL and REDIS_URL from the environment. Add a pre-deploy migration command that runs pending migrations and fails the deploy with a MIGRATION_FAILED error if a migration fails. Add a boot readiness check that confirms Postgres and Redis are reachable and exits loudly with DATABASE_UNAVAILABLE or REDIS_UNAVAILABLE if not. Infrastructure only, no business logic.
```

**Tests and QA**
- A trivial deploy of each service succeeds and the readiness check passes.
- Removing the Redis reference variable makes the worker exit with `REDIS_UNAVAILABLE`, not hang.
- The worker has no public domain.

**Security**
- Redis and Postgres are reachable only over private networking. Confirm neither has a public endpoint.

---

### Phase 1: Data layer

#### Task 1.1: Schema and migrations

**Plan mode: YES.** Schema and data-model change. A bad migration can lose data.
**Depends on: 0.2**
**Parallel with: 2.1 can start once this lands**

```text
Create the database schema and reversible migrations for the call-insight pipeline. Tables. Every purgeable table carries retention_eligible_at, soft_deleted_at, and hard_deleted_at:
- call_state: call_id (primary key), source metadata, current_stage, status, timestamps. Indefinite, not purged.
- raw_webhook_events: id, received_at, source, minimized payload, signature_status, retention_eligible_at, soft_deleted_at, hard_deleted_at. Audit only, purgeable.
- raw_transcripts: call_id, ciphertext (envelope-encrypted), key_version, fetched_at, retention_eligible_at, soft_deleted_at, hard_deleted_at.
- token_vault: token, ciphertext of original value, key_version, call_id, created_at, retention_eligible_at, soft_deleted_at, hard_deleted_at. Restricted role only.
- clean_transcripts: call_id, redacted text, redaction_risk_score, redaction_reasons jsonb, created_at, retention_eligible_at, soft_deleted_at, hard_deleted_at.
- redaction_findings: id, call_id, entity_type, token_ref or hash (never raw value in clear), residual_scan_result, created_at, retention_eligible_at, soft_deleted_at, hard_deleted_at. Purged with the clean transcript.
- structured_knowledge: call_id, extracted fields as typed columns plus jsonb arrays, schema_version, prompt_version, model_id, created_at.
- review_queue: id, call_id, held_reason (enum), status (open, in_review, resolved, unresolvable), assignee, sla_due_at, escalated_at, raw_purged_at, created_at, resolved_at. held_reason enum: redaction_failed, residual_pii_detected, classifier_uncertain, malformed_model_output, schema_invalid, emergency_review, missing_transcript, cost_cap_held, weak_servicetitan_match.
- operator_actions: id, review_queue_id, actor, action (approve, reject, reprocess, mark_non_customer, mark_spam, correct_extraction, mark_unresolvable), before jsonb, after jsonb, created_at.
- model_invocations: id, call_id, stage, model_id, prompt_version, input_tokens, output_tokens, outcome, created_at.
- daily_cost_usage: day, input_tokens, output_tokens, estimated_cost, updated_at.
- alert_events: id, error_code, root_cause_category, severity, dedup_key, acknowledged_at, created_at, and a sanitized failure_snapshot jsonb holding error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, and sanitized context.
- backfill_runs: id, window_start, window_end, last_checkpoint, status, created_at, updated_at.
- match_keys: id, call_id, phone_hmac, name_hmac, key_version, created_at, retention_eligible_at, soft_deleted_at, hard_deleted_at. ServiceTitan matching only.
- consent_gates: id, gate_type, recorded_by, evidence_ref, recorded_at.
- key_versions: key_version (primary key), status (active, rotating, retired, destroyed), wrapped_dek_ref (a pointer or identifier for the wrapped DEK, which is stored in the external secret store or key service, NOT the wrapped bytes themselves), kek_version, created_at, destroyed_at. Neither the KEK nor the wrapped DEK material is ever stored in Postgres, so they are not captured by Postgres backups.
- processing_log: id, call_id, stage, outcome, error_code, detail, created_at, and on failure rows a sanitized failure_snapshot jsonb holding error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, and sanitized context.
- dead_letter: id, call_id, job_payload (sanitized), error_code, root_cause_category, last_error, failed_at, and a sanitized failure_snapshot jsonb holding error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, and sanitized context.
Every migration has an up and a down. Create two least-privilege roles: an app role with read and write on the working tables and no DDL, and a restricted role that is the only role allowed to read token_vault and match_keys. Build envelope-encryption helpers for raw_transcripts and token_vault: a versioned key-encryption key (KEK) from the external secret store or key service wraps per-version data keys (DEKs); the wrapped DEK material lives in that external store, NOT in Postgres; the key_versions table holds only metadata and a reference (no recoverable key bytes); rows store ciphertext and key_version. Tests: migrate up then down then up and confirm the schema matches; the app role cannot read token_vault or match_keys; an encrypted row round-trips through the envelope helper; the purgeable tables (raw_webhook_events, raw_transcripts, token_vault, clean_transcripts, redaction_findings, match_keys) each have the three retention timestamps, and call_state does not.
Do not insert seed data.
```

**Tests and QA**
- Migration round-trip leaves the schema identical and loses nothing.
- The app role is denied on `token_vault` and `match_keys`.
- Envelope round-trip is exact, and the stored column is ciphertext with a `key_version`.
- Every purgeable table (`raw_webhook_events`, `raw_transcripts`, `token_vault`, `clean_transcripts`, `redaction_findings`, and `match_keys`) has all three retention timestamps. `call_state` is indefinite and does not.
- The `key_versions` registry exists, holds only key metadata and a reference, and never stores the KEK or recoverable wrapped DEK bytes, which live in the external secret store or key service.

**Security**
- Vault and match-key access is restricted at the database role level. Sensitive columns are ciphertext with a key version recorded for rotation.

---

#### Task 1.2: Data-access layer

**Plan mode: YES.** It defines the contracts every later stage writes through.
**Depends on: 1.1**
**Parallel with: 2.1 once 1.1 lands**

```text
Build a typed data-access layer over the schema. Provide zod-validated functions for each table. Every pipeline-result write is an idempotent upsert keyed on call_id. token_vault and match_keys reads go through the restricted role, isolated in single modules so access is auditable, and pass through the envelope-encryption helper. Add a helper that advances call_state.current_stage and appends a processing_log row in one transaction. Add helpers to enqueue a review_queue row with a held_reason and an sla_due_at, and to record an operator_action with before and after snapshots. Add a helper to record a model_invocation. Integration tests for: upsert idempotency, the atomic stage-advance, vault and match-key isolation, and the operator_action audit capturing before and after.
```

**Tests and QA**
- Writing the same record twice yields one row.
- The stage-advance helper is atomic.
- No module outside the vault or match-key modules imports their raw reads.
- An operator action records a complete before-and-after audit row.

**Security**
- Vault and match-key reads are funneled through auditable modules bound to the restricted role and the envelope helper.

---

### Phase 2: Queue, worker, and shared modules

#### Task 2.1: Queue and worker skeleton

**Plan mode: YES.** It sets the job model, retry posture, and failure routing for the whole system.
**Depends on: 0.3, 1.1**
**Parallel with: data layer, foundation modules**

```text
Set up BullMQ on Railway Redis and a worker that runs a per-call state machine. Stages in order: metadata-pre-filter, fetch-transcript, transcript-availability, redact, classify, extract, verbatim-pii-scan, store, mark-retention-eligible. Purge is NOT a per-call stage; it is a separate scheduled job. For now each stage is a stub that logs and advances call_state. Requirements:
- Each job keyed by call_id so duplicate enqueues collapse to one.
- Exponential backoff with a capped retry count.
- A job that exhausts retries moves to dead_letter with error_code QUEUE_RETRY_EXHAUSTED and sanitized root-cause metadata, and emits DEAD_LETTER_CREATED.
- Every stage transition writes a processing_log row.
- A kill switch env var pauses the worker cleanly without losing queued jobs.
Use the shared failure-model modules from Task 2.2 once available. Integration tests for: idempotent enqueue, retry then success, retry exhaustion landing in dead_letter with the right error_code, and the kill switch pausing without dropping jobs.
```

**Tests and QA**
- Enqueueing the same `call_id` twice runs the pipeline once.
- A stage that fails twice then succeeds completes without help.
- A stage that always fails lands in `dead_letter` with `QUEUE_RETRY_EXHAUSTED` and emits one `DEAD_LETTER_CREATED` alert.
- The kill switch pauses the worker and queued jobs survive a restart.

**Security**
- No transcript text in logs or in dead-letter payloads.

---

#### Task 2.2: Failure-model modules

**Plan mode: YES.** It is the shared error and alert backbone every other task uses.
**Depends on: 0.2**
**Parallel with: data layer, queue**

```text
Build the shared failure-model modules that implement the specification in section 2.7. Deliverables:
- A typed error model: a base error type carrying error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, and context. A complete enum of the root-cause categories.
- A severity mapping from each error_code to a default severity.
- An alert formatter that renders an error into the plain-language alert contract: what broke, likely root cause, impact, immediate remediation, longer-term fix, whether data is safe, whether calls are held or retried or dropped, runbook pointer, timestamp, environment. It must never include transcript content or PII.
- A dedup-key function so repeated identical failures collapse to one alert during an incident.
- An escalation helper that marks a critical alert for escalation if not acknowledged within a configured window, recording to alert_events.
- A static remediation catalog keyed by error_code and root_cause_category, supplying for each: a non-empty impact, an immediate remediation, a longer-term fix or the explicit value "same as immediate," a data-safety status, a calls-state, an owner, and a runbook_ref. There is no generic UNKNOWN fallback entry.
- Test fixtures: a sample error per category, and a golden set of formatted alerts to assert against.
Tests: every root-cause category has a severity and a formatted alert; the formatter never emits PII even when context is populated; the dedup key collapses repeated failures; an unacknowledged critical error escalates; and a completeness test asserts that every error_code and every root-cause category has a non-empty impact, immediate remediation, longer-term fix (or explicit "same as immediate"), data-safety status, calls-state, owner, and runbook_ref, and that no generic UNKNOWN fallback satisfies the catalog.
```

**Tests and QA**
- Every category maps to a severity and renders a complete, PII-free alert.
- Every error_code and root-cause category has a non-empty impact, immediate remediation, longer-term fix or explicit "same as immediate," data-safety status, calls-state, owner, and runbook_ref. No generic UNKNOWN fallback passes.
- The dedup key collapses repeated identical failures to one alert.
- An unacknowledged critical alert escalates within the window.

**Security**
- The formatter is incapable of emitting transcript content or PII, proven by a test that populates context with a fake PII value and asserts it never appears.

---

#### Task 2.3: Shared hardening and auth middleware

**Plan mode: YES.** It is the security layer every public and internal surface depends on.
**Depends on: 0.2, 2.2**
**Parallel with: data layer, queue**

```text
Build shared HTTP middleware so every surface in this system is protected the same way, no surface rolling its own. Provide:
- A request body size limit, configurable, rejecting oversized bodies.
- Per-source rate limiting.
- An authentication and session layer for internal surfaces (status, review, knowledge base) using the chosen auth provider. No anonymous access.
- Building blocks for signed webhooks: a signature-verification hook, a replay-protection store keyed by event id with a configurable window, and a timestamp-skew validator. These are wired per webhook by the consuming task.
- Error responses that use the failure-model formatter and contain no transcript content or PII.
Tests: oversized bodies are rejected; rate limiting trips at the configured threshold; an unauthenticated request to an internal route is refused; the replay store rejects a duplicate event id within the window; the timestamp validator rejects a stale event; no error response contains PII.
```

**Tests and QA**
- Oversized, rate-exceeding, and unauthenticated requests are all rejected.
- The replay store rejects duplicates within the window.
- The timestamp validator rejects stale events.
- No error response leaks PII.

**Security**
- One consistent, tested protection layer. Consuming tasks add only their surface-specific checks (for example a Dialpad signature) on top.

---

### Phase 3: Ingestion

Metadata pre-filter runs before any transcript is fetched, so junk never costs a transcript pull.

#### Task 3.1: Metadata pre-filter

**Plan mode: NO.** Pure rules over metadata, no model, no PII, no transcript fetch.
**Depends on: 2.1, 1.2**
**Parallel with: webhook receiver, transcript client, redaction, model steps**

```text
Build the metadata-pre-filter stage. Using call metadata only (direction, duration, call state, and the related-call graph fields like operator_call_id and master_call_id), drop calls that are obviously not customer conversations BEFORE any transcript is fetched. Examples: zero-duration calls, outbound-only legs that carry no customer conversation, and internal transfer legs that are not the true operator leg. This stage reads no transcript and triggers no transcript fetch. A dropped call is marked with a reason in call_state and set aside, never deleted. Be conservative: when unsure, pass the call through. Unit tests with metadata fixtures for each rule, including the transfer-graph case where only the true operator leg passes, and an explicit assertion that dropped calls never trigger a transcript fetch.
```

**Tests and QA**
- Each drop rule has a fixture and a test.
- Zero-duration, outbound-only, and internal-transfer junk is dropped and never triggers a transcript fetch.
- An ambiguous call passes through rather than being dropped.
- Dropped calls are recoverable, with a reason recorded.

**Security**
- Metadata only. No transcript content read, no transcript fetched.

---

#### Task 3.2: Webhook receiver

**Plan mode: YES.** Public endpoint, signature verification, replay protection. Security-sensitive.
**Depends on: 3.1, 2.3**
**Parallel with: 3.3**

```text
Build the Dialpad webhook-receiver service on top of the shared Task 2.3 middleware. The middleware provides body size limits, rate limiting, replay protection, timestamp validation, and PII-free error responses. This task adds the Dialpad-specific parts:
- Verify the JWT HS256 signature on every event using the shared secret from config. Reject WEBHOOK_SIGNATURE_INVALID before any other work.
- Wire the replay-protection store with Dialpad's event id and reject duplicates with WEBHOOK_REPLAY_DETECTED. Validate the event timestamp where the payload supports it.
- On a valid event, store a raw_webhook_events row that keeps only an explicit allowlist of metadata fields (event id, call id, direction, call state, timestamps, signature status), hashes or tokenizes phone or name if either appears in the payload, and stores no transcript or message content. Enqueue an ingest job keyed by call_id and return 200 in well under a second. No heavy work in the request path.
- Document a secret-rotation procedure for the webhook secret.
Tests: valid signed event enqueues exactly one job; invalid signature rejected with no enqueue; replayed event rejected with WEBHOOK_REPLAY_DETECTED; oversized body rejected by the middleware; malformed event rejected without enqueue; the 200 path stays fast; no response contains PII; planted PII in a webhook payload is never stored in clear (only allowlisted metadata is kept, and any phone or name is hashed).
```

**Tests and QA**
- Tampered, unsigned, oversized, replayed, and malformed events are all rejected with the right code and no enqueue.
- A valid event enqueues exactly one job and returns 200 fast.
- No response body contains PII, and `raw_webhook_events` stores only allowlisted metadata with phone or name hashed. Planted PII in a payload is never stored in clear.

**Security**
- Generic protections come from the shared middleware. Dialpad signature and replay sit on top. The secret has a rotation procedure.

---

#### Task 3.3: Dialpad transcript client

**Plan mode: YES.** Handles a credential and an external API.
**Depends on: 3.1**
**Parallel with: 3.2**

```text
Build a Dialpad API client that fetches the AI transcript for a call_id, and lists recently concluded calls for the reconciliation sweep. Respect BOTH rate limits: 1200 requests per minute on the transcript endpoint and 20 requests per second at the company level, using a limiter that enforces the tighter of the two. Retry on 429 with backoff and emit DIALPAD_RATE_LIMITED with a recommendation to wait, not a generic error. On auth failure emit DIALPAD_AUTH_FAILED. If the response shape is not what we expect, emit DIALPAD_API_CHANGED rather than crashing. The transcript is fetched only for calls that passed the metadata pre-filter. On success, write the transcript to raw_transcripts through the envelope-encrypted data-access layer and advance call_state. Transcript availability: if the transcript is not yet ready, do not fail the call; mark it for a bounded retry, and if it never arrives within the window, hold it with reason missing_transcript and emit DIALPAD_TRANSCRIPT_MISSING. The API key comes from validated config. Mock Dialpad in tests. Contract tests for: a normal transcript, a not-yet-ready transcript that later arrives, a transcript that never arrives (held with missing_transcript), a 429 (rate-limited, recommends waiting), a 5xx, an auth failure, and an unexpected shape (DIALPAD_API_CHANGED). Assert no transcript content is ever logged.
```

**Tests and QA**
- A normal fetch stores the transcript and advances state.
- A 429 produces `DIALPAD_RATE_LIMITED` advising a wait, not "unknown error."
- A not-yet-ready transcript retries within the window, then holds with `missing_transcript` if it never arrives.
- An unexpected response shape produces `DIALPAD_API_CHANGED`, not a crash.
- Both rate limits are honored.
- No transcript content in any log.

**Security**
- The key is read from config. Transcript content is never logged. The stored transcript is encrypted.

---

#### Task 3.4: Reconciliation cron

**Plan mode: NO.** Small, isolated, read-then-enqueue.
**Depends on: 3.2, 3.3**
**Parallel with: redaction, model steps**

```text
Build the reconciliation-cron entrypoint. On each run it lists calls concluded in a recent window from Dialpad metadata, checks call_state for any never ingested, and enqueues jobs for the gaps. It uses metadata and does not fetch transcripts itself; the worker does that after the pre-filter. Idempotent: a call already in the pipeline is skipped. It runs to completion and exits, and pings its own external check on success. Log a one-line summary of calls checked and gaps enqueued. Tests: a missed call is enqueued, an already-processed call is skipped, an empty window exits cleanly, and its own check is pinged only on success.
```

**Tests and QA**
- A missed call is picked up on the next sweep.
- An already-processed call is not re-enqueued.
- Its own external check is pinged only on success.

**Security**
- Read-only metadata plus enqueue. No content logged, no transcript fetched here.

---

### Phase 4: Redaction

#### Task 4.1: Redaction, vault, and residual scan

**Plan mode: YES.** This is the privacy boundary, the most security-critical task in the build.
**Depends on: 1.1 (and the raw_transcripts contract)**
**Parallel with: ingestion, model steps. Build against synthetic transcripts.**

```text
Build the redaction stage. It reads a raw transcript and produces redacted text, a token vault, and a risk assessment, so no personal detail reaches the model. Do not claim perfect coverage on unknown real transcripts. Instead:
Layered detection:
- A named-entity pass (for example Microsoft Presidio or an equivalent) for names, locations, and organizations including business names.
- Regex passes for phone numbers, emails, street addresses, cross-streets, credit card numbers, and government ID numbers.
- A deny-list for client-specific terms that must never pass.
Each detected value is replaced with a stable token, and the token-to-value map is written to token_vault through the restricted, envelope-encrypted data-access layer. Record per-call findings in redaction_findings using token references or hashes, never raw values in clear.
Risk scoring instead of a single coverage number: compute a risk score with explicit reasons.
Residual-PII scan: after redaction, run a second independent scan over the redacted output. Any residual hit, or a risk score above a configurable threshold, holds the call with reason redaction_failed or residual_pii_detected and does not pass it onward.
Tests:
- A labeled synthetic corpus with known PII, measuring recall against a configurable target, with CI failing on a REDACTION_RECALL_REGRESSION below target.
- A no-egress test asserting the outgoing text contains none of the corpus PII values.
- A residual-scan test: a transcript that defeats one detection layer is caught by the residual scan and held.
- A vault round-trip test through the envelope helper.
- An adversarial set covering names, street addresses, cross-streets, phone numbers, emails, business names, and spelling and spacing variations, all held or redacted, none passed.
```

**Tests and QA**
- Corpus recall meets or beats the target, enforced in CI.
- The no-egress test passes.
- A transcript that beats one layer is caught by the residual scan and held.
- The adversarial set is fully redacted or held, never passed.
- Vault round-trip through envelope encryption is exact.

**Security**
- This is the hard line. Findings store references, not clear values. The risk score and residual scan replace the false comfort of a single coverage number. Fail closed on any residual hit.

---

### Phase 5: Classification and extraction

#### Task 5.1: Classifier

**Plan mode: YES.** LLM integration plus routing that carries brand risk if it mislabels.
**Depends on: 4.1 output contract**
**Parallel with: ingestion, observability. Build against redacted fixtures.**

```text
Build the classify stage. It sends redacted text to the Anthropic API using a configurable Haiku model id (default claude-haiku-4-5-20251001) and sorts each call into customer, non-customer, spam, or held. The prompt returns only structured JSON with the bucket and a short reason. Validate with zod; a malformed response holds the call with reason malformed_model_output and emits MODEL_MALFORMED_RESPONSE. A low-confidence or ambiguous classification holds with reason classifier_uncertain. Spam and held are set aside in call_state and enqueued to review_queue, never deleted. Record every call in model_invocations with the model id and prompt version. The stage sits behind a feature flag with a kill switch. Treat the transcript as data, not instructions, and say so in the system prompt. Tests: golden fixtures with expected buckets; a malformed response holds and emits the right code; a prompt-injection fixture does not change labeling; an uncertain case routes to classifier_uncertain; the kill switch halts cleanly; model_invocations is written.
```

**Tests and QA**
- Golden fixtures classify as expected.
- A garbled response becomes `malformed_model_output` and emits `MODEL_MALFORMED_RESPONSE`.
- The injection fixture does not move calls to spam.
- An uncertain case routes to `classifier_uncertain`.
- `model_invocations` records the model id and prompt version.

**Security**
- Only redacted text is sent. The transcript is treated as data. The kill switch can stop model spend instantly.

---

#### Task 5.2: Extractor and verbatim PII scan

**Plan mode: YES.** Schema, gates, the durable record, and a second PII line of defense.
**Depends on: 5.1**
**Parallel with: observability**

```text
Build the extract stage. For customer calls, send the redacted text to the Anthropic API using a configurable Sonnet model id (default claude-sonnet-4-6) and return a record against this schema, validated with zod:
- call_intent: enum (new booking, existing job, quote, emergency, billing, general)
- service_category: a controlled list of plumbing categories, not free text
- problem_statement: short neutral summary
- symptoms: array
- customer_language: array of PII-free verbatim phrases for marketing
- location_in_home, access_or_scheduling_notes, prior_attempts: strings
- urgency: enum (emergency, urgent, routine), labeled customer-stated, not authoritative
- concerns: array
- sentiment: enum, internal only, never customer-facing
- acquisition_source, competitor_mentions: for marketing
Deterministic gates, not model self-scores:
- schema_valid: malformed output is rejected and the call holds with reason schema_invalid.
- urgency_flag: a rule flags anything read as emergency for review (emergency_review). When unsure, urgency defaults upward.
Second PII scan: run the residual-PII scanner over every customer_language phrase before storing. Any hit holds the record with reason residual_pii_detected. No confidence scores are written. Sentiment never leaves the internal store. Record model_invocations with model id and prompt version. Tests: golden fixtures; a schema violation holds with schema_invalid; an emergency trips emergency_review; service_category is always a controlled value; a customer_language phrase containing planted PII is caught and held, and no labeled PII ever appears in a stored marketing phrase.
```

**Tests and QA**
- Golden fixtures extract as expected.
- Malformed output holds with `schema_invalid`.
- An emergency call trips `emergency_review`.
- `service_category` is always controlled.
- A planted-PII marketing phrase is caught and held. No labeled PII reaches a stored phrase.

**Security**
- Sentiment internal only. No confidence scores. Only redacted text was sent. Verbatim phrases get a second PII scan before storage.

---

#### Task 5.3: Store the record and mark retention-eligible

**Plan mode: NO.** It writes through the data-access layer.
**Depends on: 5.2**
**Parallel with: observability**

```text
Build the store stage. Write the validated record to structured_knowledge through the idempotent upsert keyed by call_id, recording schema_version and prompt_version, and advance call_state to complete. Then mark the raw_transcripts and token_vault rows for this call as retention-eligible by stamping retention_eligible_at. Do NOT delete anything here. Re-running a call updates the record rather than duplicating. Integration test: run a fixture call through extract and store twice and confirm exactly one record exists reflecting the latest run, and that retention_eligible_at is stamped on the raw and vault rows but nothing is deleted.
```

**Tests and QA**
- Storing the same call twice yields one record reflecting the latest run.
- `call_state` advances to complete only after a successful store.
- Raw and vault rows are stamped retention-eligible, nothing deleted inline.

**Security**
- Only the de-identified record is stored long term. Deletion is deferred to the scheduled job.

---

### Phase 6: Held-for-review workflow

#### Task 6.1: Review queue wiring and held-call retention policy

**Plan mode: YES.** It is the recovery path for every held call and it bounds raw PII retention.
**Depends on: 1.1, 5.3**
**Parallel with: observability, retention**

```text
Wire every hold path to the review_queue and implement the held-call retention policy. Any stage that holds a call creates exactly one open review_queue row with the specific reason, the call_id, and an sla_due_at, and is idempotent so a re-held call does not duplicate.
Held-call retention policy (configurable):
- Review SLA: each held reason has a target resolution window. emergency_review has the shortest. When sla_due_at passes, the item is escalated (escalated_at set) and a REVIEW_QUEUE_STALLED alert fires per the alert contract.
- Maximum raw retention for unresolved holds: a hard cap, independent of the normal retention window. When it passes, the retention job (Task 8.1) purges the raw_transcripts and token_vault for that held call and stamps raw_purged_at on the review_queue row. The redacted clean transcript and the review_queue row survive, so a reviewer can still resolve on redacted text or mark the item unresolvable.
- Unresolvable path: a reviewer can mark an item unresolvable; it is archived with that status, and its raw is purged on the unresolved-hold cap regardless.
A held call's data is preserved while it is open and within the cap, never silently dropped. Tests: each hold reason creates one queue row with an sla_due_at; a past-due item escalates and emits REVIEW_QUEUE_STALLED; a held call's data is recoverable while open; re-holding does not duplicate; an item past the raw-retention cap has its raw and vault purged while the redacted record and the queue row survive; a reviewer can mark an item unresolvable.
```

**Tests and QA**
- Each hold reason creates exactly one open review row with an SLA.
- A past-due item escalates and emits `REVIEW_QUEUE_STALLED`.
- A held call is recoverable while open and within the cap.
- Re-holding is idempotent.
- Past the raw-retention cap, raw and vault are purged while the redacted record and the queue row survive.
- An item can be marked unresolvable.

**Security**
- Held calls do not retain raw PII indefinitely. There is a review SLA, an escalation, a hard cap on raw retention, and an unresolvable path.

---

#### Task 6.2: Review surface (authenticated)

**Plan mode: YES.** Authenticated internal tool that can expose raw content. Highly sensitive.
**Depends on: 6.1, 2.3**
**Parallel with: observability**

```text
Build a small authenticated review and admin surface for OVIO reviewers, on top of the shared Task 2.3 middleware (auth, size limits, rate limiting, PII-free responses). Requirements:
- Authentication required. No anonymous access. Sessions expire.
- List open review_queue items with their held reason, a plain-language explanation, and the SLA status.
- Visibility rules: by default reviewers see redacted content. Raw transcript or vault values are shown only to an elevated role, only for the held call being reviewed, and every raw view is logged as an operator_action. Most hold reasons can be resolved on redacted content alone.
- Actions, each recorded in operator_actions with before and after: approve, reject, reprocess (re-enter the pipeline from a chosen stage), mark non-customer, mark spam, correct extraction, mark unresolvable.
- Reprocess re-enters the pipeline safely and idempotently, with no duplicate records and no double-write downstream.
- No transcript content or PII in logs or in any response to an unauthorized caller.
Tests: unauthorized access refused; a redacted-only reviewer cannot see raw values; an elevated raw view is logged; each action writes a complete operator_actions audit row; a reprocessed call re-enters and completes without duplicating records; an oversized or malformed request is rejected by the middleware.
```

**Tests and QA**
- Unauthorized access is refused.
- A standard reviewer sees redacted content only. Raw views require elevation and are logged.
- Each action writes a full audit row.
- A reprocessed call completes without duplicates.
- Hardening tests pass via the shared middleware.

**Security**
- Raw content is gated behind an elevated role, scoped to the call, and audited.

---

#### Task 6.3: Reviewed decisions become evaluation data

**Plan mode: NO.**
**Depends on: 6.2**
**Parallel with: observability**

```text
Turn resolved review decisions into labeled fixtures and evaluation data. When a reviewer corrects a classification or an extraction, capture the redacted input and the corrected output as a labeled example, with PII already removed, and write it to a versioned fixtures or evaluation store. These feed the golden-fixture tests and a periodic accuracy check on the classifier and extractor. Tests: a correction produces one labeled example with no PII; the example is loadable by the golden-fixture test harness; the evaluation check reports accuracy against the growing labeled set.
```

**Tests and QA**
- A correction yields one PII-free labeled example.
- The example loads into the golden-fixture harness.
- The evaluation check reports accuracy against the labeled set.

**Security**
- Labeled examples are built from redacted inputs only.

---

### Phase 7: Observability and fail-loud

This phase implements the operational failure model from section 2.7 using the Task 2.2 modules.

#### Task 7.1: Per-component dead-man's switches

**Plan mode: NO.** Small wiring task, high importance.
**Depends on: 2.1**
**Parallel with: everything**

```text
Wire each component to its OWN external check. The worker, the reconciliation cron, and the retention cron each ping a separate external check slug on its own cadence. Do not share one check across components, because a healthy worker would mask a dead cron. A missed ping on any check makes the external monitor alert OVIO, naming the component. The check URLs are config, one per component. Add tests that simulate, in staging, a stalled reconciliation cron while the worker keeps pinging, and confirm the reconciliation check still fires its alert. Document in CLAUDE.md that heartbeats stay external and per-component, and why.
```

**Tests and QA**
- Each component pings only its own check on a healthy cycle.
- A stalled reconciliation cron alerts even though the worker keeps pinging.
- A stalled retention cron alerts independently.

**Security**
- Pings carry no customer data.

---

#### Task 7.2: Cost guardrails

**Plan mode: NO.**
**Depends on: 2.1 and the model steps to be meaningful**
**Parallel with: everything**

```text
Add token and cost guardrails around the Anthropic calls, recording to daily_cost_usage. Set a configurable daily budget. A warning threshold alerts OVIO without stopping. The hard cap trips the model kill switch, holds further calls with reason cost_cap_held, and emits MODEL_COST_CAP_EXCEEDED. Tests: the warning alerts without stopping; the hard cap halts model calls, holds cleanly with cost_cap_held, and emits the right code; daily_cost_usage totals are correct.
```

**Tests and QA**
- The warning threshold alerts without stopping the pipeline.
- The hard cap halts model calls and holds with `cost_cap_held`.
- `daily_cost_usage` totals are correct.

**Security**
- A runaway loop cannot spend without bound.

---

#### Task 7.3: Status surface and alert delivery

**Plan mode: YES.** Authenticated surface plus the alert pipeline.
**Depends on: 2.1, 2.2, 2.3. Reads health signals from 7.1, 7.2, and 7.4 where present, degrading to unknown when a signal is absent, so it does not block on them.**
**Parallel with: everything**

```text
Build an authenticated, mobile-friendly status surface for Eric on top of the shared Task 2.3 middleware, and the alert delivery for OVIO using the Task 2.2 modules.

The status surface has two parts, both showing health and counts only, never content or PII:

1. A plain-language summary: is the pipeline running, when did each component last run, calls processed today, calls held for review, current spend against the daily budget, and whether anything is broken, including a degraded or broken state with its explicit cause drawn from the latest alert_events.

2. A structure-plus-health view of the pipeline. Render the pipeline state machine from section 2.3 as a fixed diagram (metadata pre-filter, fetch transcript, availability check, redact, classify, extract, second PII scan, store, mark retention-eligible) plus the surrounding components (webhook receiver, worker, reconciliation cron, retention cron). Each node shows a state from a small fixed vocabulary (healthy, idle, degraded, broken, paused) and the count of calls currently at that stage. Components draw their state from their own external check (Task 7.1) and their last-run time. Stage states and counts draw from call_state.current_stage, review_queue counts by held reason, the dead_letter count, the counters from Task 7.4, and daily_cost_usage with the model kill-switch state from Task 7.2 (a tripped kill switch shows the model stages as paused). A node whose signal is not yet available renders as unknown rather than failing the page. The view reflects current state on load or refresh. There is no live per-call execution animation; that is deferred to a later gated increment.

The view must never display transcript content, raw transcripts, the token vault, redaction findings in clear, customer_language phrases, or any phone or name. Stage labels, node states, and counts only.

Alert delivery uses the formatter, dedup, and escalation from Task 2.2 and records to alert_events. Authentication required via the shared middleware.

Tests: the plain-language summary renders a known state clearly and shows a broken state with its cause; the structure-plus-health view renders every pipeline stage and component with a state and a count, reflects a seeded broken component as broken and a seeded held backlog as a count at the held stage, shows the model stages as paused when the kill switch is tripped, and renders a node with no signal as unknown; for every seeded state the rendered view contains no transcript content, no customer_language, and no PII; an unauthenticated request is refused; a simulated failure emits exactly one actionable alert, not a trace; repeated failures deduplicate to one alert; an unacknowledged critical alert escalates; a mobile-width render is verified.
```

**Tests and QA**
- The plain-language summary reads clearly on mobile and shows a broken state with its cause.
- The structure-plus-health view renders every stage and component with a state and a count, and shows a seeded broken component and a seeded held backlog correctly.
- The model stages show as paused when the cost kill switch is tripped.
- A node with no signal renders as unknown, not an error.
- The rendered view contains no content, no customer_language, and no PII for any seeded state.
- Unauthenticated access is refused.
- One failure emits exactly one actionable alert.
- Repeated failures deduplicate; critical alerts escalate.

**Security**
- Authenticated. Structure, counts, and health only, never content, customer_language, or PII. The pipeline view reflects state; it does not stream or expose per-call data.

---

#### Task 7.4: Logging, audit, metrics, and error codes

**Plan mode: NO.**
**Depends on: 2.1, 2.2**
**Parallel with: everything**

```text
Finalize structured logging, metrics, and the error-code surface using the Task 2.2 modules. Every stage logs start, success, and failure with the call_id, the stage, and an error_code on failure, never content. Map each failure path to its root-cause category and confirm each emits exactly one actionable alert. Persist the sanitized failure snapshot from Task 2.2 (error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, sanitized context) to alert_events, to processing_log failure rows, and to dead_letter, so a failure is explainable after the fact, not only at alert time. Expose counters: calls ingested, held by reason, classified per bucket, extracted, dead-lettered, and alerts by code. Confirm processing_log gives a full per-call audit trail. Tests: a single call traces end to end by call_id; no log line contains content or PII; a simulated boot failure names the missing dependency or config value; a simulated Dialpad 429 produces a rate-limited message recommending backoff, not "unknown error"; a simulated malformed model response produces a model-schema-failure message and holds the call; alert_events, processing_log failure rows, and dead_letter rows each persist the full sanitized failure snapshot, and every persisted runbook_ref resolves to a runbook entry.
```

**Tests and QA**
- A call traces end to end by `call_id`.
- No log line contains content or PII.
- A boot failure names the missing dependency or config value.
- A Dialpad 429 reads as rate-limited with a backoff recommendation.
- A malformed model response reads as a schema failure and holds the call.
- `alert_events`, `processing_log` failure rows, and `dead_letter` rows each persist the full sanitized failure snapshot, and every persisted `runbook_ref` resolves to a runbook entry.

**Security**
- Logs are content-free by design. Alerts are actionable, not raw traces.

---

### Phase 8: Retention (scheduled)

#### Task 8.1: Scheduled retention job

**Plan mode: YES.** It deletes sensitive data. Handle with care.
**Depends on: 1.1**
**Parallel with: model steps, observability**

```text
Build the retention-cron job. It runs on a schedule, independent of the per-call pipeline, and purges rows whose retention_eligible_at has passed its window. It covers all purgeable tables: raw_transcripts, token_vault, raw_webhook_events, match_keys, and clean_transcripts with its redaction_findings, per config. Two windows per table: soft-delete first (set soft_deleted_at, keep recoverable), then hard-delete after a longer window (set hard_deleted_at, remove plaintext). It also enforces the held-call raw-retention cap from Task 6.1: a held call past its cap has its raw_transcripts and token_vault purged and raw_purged_at stamped on the review_queue row, while the redacted record and the queue row survive. structured_knowledge is never purged here. A dry-run mode reports what would be purged without purging. A purge failure emits RETENTION_PURGE_FAILED and does not silently skip rows. Windows are config. It pings its own external check on success. Tests: nothing purges before its window; soft precedes hard; structured records and configured clean transcripts survive; raw_webhook_events and match_keys purge on their own windows; a held call past its cap has raw and vault purged while the queue row and redacted record survive; dry-run changes nothing; a soft-deleted row is recoverable within the window; a simulated failure emits RETENTION_PURGE_FAILED.
```

**Tests and QA**
- Nothing purges before its window. Soft precedes hard.
- `raw_webhook_events` and `match_keys` purge on their own windows, and `redaction_findings` purge with their clean transcript.
- Structured records survive; configured clean transcripts survive.
- A held call past its cap has raw and vault purged while the queue row and redacted record survive.
- Dry-run changes nothing. A soft-deleted row is recoverable within the window.
- A failure emits `RETENTION_PURGE_FAILED`, not a silent skip.

**Security**
- Deletion is off the per-call path, auditable, reversible within the grace window, fail-loud, and covers every purgeable table including held-call raw caps.

---

#### Task 8.2: Backup, key hierarchy, and restore drill

**Plan mode: YES.** It reconciles the deletion promise with database backups and defines the key lifecycle.
**Depends on: 8.1, 0.3**
**Parallel with: observability**

```text
Reconcile retention with Postgres point-in-time recovery and backups, and define the key hierarchy precisely. Deliverables:
- A written backup retention policy stating how long PITR and any snapshots retain data, and therefore the true maximum lifetime of a purged raw transcript or vault row inside backups.
- A clear statement of what purge does and does not mean: purge removes plaintext from the live database, but backups taken before purge still contain those rows until the backup window rolls off.
- A precise key hierarchy for the envelope encryption on raw_transcripts and token_vault. The decisive design point: the wrapped DEK material and the KEK must live OUTSIDE the backed-up Postgres database, or crypto-shredding does not reach backups. Reason: a backup taken before deletion captures the row that held the wrapped DEK; if the KEK still exists, restoring that backup restores the wrapped DEK and decryption works again. So:
  - A versioned key-encryption key (KEK) held in a secret store or key service that is not part of Postgres backups.
  - Per-version data keys (DEKs), each wrapped by the current KEK. The wrapped DEK material is stored in that same external store, not in Postgres. The key_versions table in Postgres holds only metadata and a reference (key_version, status, wrapped_dek_ref pointer, kek_version, created_at, destroyed_at). Rows record key_version.
  - Key version lifecycle, tracked by the status column: active, rotating, retired, destroyed.
  - Rotation process: introduce a new DEK version, re-encrypt eligible rows to it, and only after re-encryption completes and is verified, destroy the old DEK by deleting its wrapped material from the external store and marking the key_versions row destroyed. Because the wrapped material was never in Postgres, no Postgres backup ever contained it, so once it is deleted from the external store the old ciphertext is unreadable in the live database and in any restored backup.
  - Emergency revocation: destroy a target DEK or a whole KEK version in the external store. State exactly what becomes unrecoverable: every row encrypted under the destroyed key, in the live database and in all backups, becomes permanently unreadable. Irreversible, so gated behind a deliberate procedure. If a dedicated key service is not available, the fallback is versioned KEKs whose material is held outside the database backups and destroyed on revocation; do not rely on deleting a Postgres-resident wrapped DEK, since backups would still hold it.
- A key-store deletion verification step. Before treating crypto-shredding as valid, confirm and document the external secret store or KMS deletion semantics: whether deleted key material can be restored; whether the service has soft-delete, recovery windows, version history, backups, replicas, or delayed destruction; the maximum time destroyed key material may remain recoverable; whether emergency revocation is immediate or delayed; who is authorized to destroy keys; and how destruction is audited. Crypto-shredding only counts after the relevant DEK or KEK version is no longer recoverable from the external key store, including from soft-delete, recovery, or version history. If the key store has a mandatory recovery window, document that window as part of the true deletion timeline.
- A restore drill: a documented, tested procedure to restore from backup into an isolated environment, verify integrity, and confirm that rows whose key material was destroyed are unreadable after a simulated revocation, even though the restore is otherwise intact.
Tests where automatable: a rotation test that re-encrypts under a new key_version and, after deleting the old DEK material from the external store, confirms old ciphertext is unreadable; the decisive backup test, which restores a backup taken BEFORE destruction and confirms that rows whose DEK material was later destroyed cannot be decrypted even though the KEK still exists, proving the wrapped material was never in the backup; an emergency-revocation test that destroys a DEK or KEK version and confirms every row at that version is unreadable in a restored copy; a restore-drill checklist that runs in staging.
Add a key-store deletion-semantics test or checklist: destroy or schedule destruction of a test DEK or KEK version; confirm the key store reports it as unrecoverable, or record the exact recovery window if immediate destruction is impossible; restore a Postgres backup taken before key destruction; confirm rows at the destroyed key version cannot be decrypted once the external key material is unrecoverable; fail the launch gate if the key can still be restored without an approved emergency process.
```

**Tests and QA**
- The backup retention policy and the meaning of purge are written down and reviewed.
- The wrapped DEK material and the KEK live outside the backed-up Postgres database; `key_versions` holds only metadata and a reference.
- Rotation re-encrypts to a new `key_version` and, after deleting the old DEK material from the external store, old ciphertext is unreadable.
- The decisive backup test passes: a backup taken before destruction, when restored, cannot decrypt rows whose DEK material was later destroyed, even though the KEK still exists.
- The key store's deletion semantics are documented: recoverability, any soft-delete or recovery window, version history, replicas, who may destroy keys, and how destruction is audited. The true deletion timeline reflects any mandatory recovery window.
- The deletion-semantics test passes: after the external key material is unrecoverable, a restored pre-destruction backup cannot decrypt rows at that version. The launch gate fails if the key can still be restored without an approved emergency process.
- Emergency revocation makes every row at the destroyed key or KEK version unreadable in a restored copy.
- The restore drill runs in staging and confirms integrity and crypto-shred behavior.

**Security**
- The deletion promise is honest and reaches backups, because the key material was never in the backed-up database. Crypto-shredding counts once the external key material is destroyed, and the procedure makes explicit what becomes permanently unrecoverable.

---

### Phase 9: Public endpoint security audit

#### Task 9.1: Cross-cutting security audit and test suite

**Plan mode: YES.** A security audit across every public and internal surface.
**Depends on: 3.2, 6.2, 7.3, 10.1**
**Parallel with: nothing, runs after the surfaces exist**

```text
Audit that every externally reachable surface (the Dialpad webhook receiver, the status surface, the review surface, the knowledge-base surface, and later the ServiceTitan webhook) uses the shared Task 2.3 middleware and adds only its surface-specific checks. Do not re-implement protections per surface; confirm they come from the shared middleware. Add a security test suite that runs against all surfaces: malicious and malformed payloads, replayed events, oversized bodies, invalid or missing auth, and duplicate events, each rejected with the correct error code and no side effects. Flag any surface that bypasses the shared middleware.
```

**Tests and QA**
- Every surface uses the shared middleware; none rolls its own protections.
- Malicious, malformed, oversized, replayed, and unauthenticated requests are rejected with the right code and no side effects.
- Duplicate events do not double-process anywhere.
- No surface leaks content or PII.

**Security**
- One audited, consistent protection layer, proven by a shared security suite.

---

### Phase 10: Knowledge-base surface (minimal, read-only)

#### Task 10.1: Search, export, and summaries

**Plan mode: YES.** Authenticated surface that returns potentially sensitive aggregates.
**Depends on: 5.3, 2.3**
**Parallel with: observability. Phase 9 (the security audit) depends on this surface and runs after it exists.**

```text
Build a minimal authenticated read-only knowledge-base surface over structured_knowledge, on top of the shared Task 2.3 middleware for auth and hardening. Features:
- Search and filter records by service_category, call_intent, urgency, date range, and free-text over the neutral problem_statement and customer_language fields.
- Export the current filtered view to CSV and JSON.
- Plain-language summaries for a non-technical reader.
- No PII leakage: the surface reads only the de-identified structured store and never the vault or raw transcripts. The free-text search and export include the verbatim customer_language field, which is the highest-risk leak path; that field reaches the store only after passing the second PII scan in Task 5.2, and a record that fails the scan is held, not stored. A test asserts that no export or summary, and in particular no customer_language value, can contain a value from the labeled PII corpus.
- Authentication required via the shared middleware.
Tests: search and filter return correct records; CSV and JSON exports match the filtered view; a summary renders in plain language; an export cannot contain labeled PII; unauthenticated access is refused.
```

**Tests and QA**
- Search and filter return correct records.
- Exports match the filtered view in both formats.
- Summaries read clearly for a non-technical user.
- No export or summary can contain labeled PII.
- Unauthenticated access is refused.

**Security**
- Reads only the de-identified store. Authenticated through the shared middleware. Proven PII-free exports.

---

### Phase 11: Validation and backfill

#### Task 11.1: Sample validation harness

**Plan mode: NO** for the harness. It may run against real calls in staging only, and only after the section 0.2 processing gates are recorded, plus the ServiceTitan matching consent if the run touches that path.
**Depends on: 5.3**
**Parallel with: observability**

```text
Build a sample-validation harness. It runs a small batch of real calls through the full pipeline in staging, then produces a side-by-side report of the redacted text and the extracted record for human review, so we can judge quality and tune the classifier and extractor before going wide. It writes nothing to any production store. It refuses to run against real calls unless the section 0.2 processing gates are recorded in consent_gates: recording consent, the signed services agreement and data-processing addendum, the Anthropic no-train confirmation, and the Anthropic data-retention confirmation. The ServiceTitan matching consent is required only if this validation run exercises ServiceTitan or match-key behavior; if the run does not touch that path, it is not required. Include a way to mark each sample correct or wrong to seed the labeled baseline used by Phase 6.3. Tests: it runs in staging only; it writes to no production store; the gate check blocks it unless the processing gates are recorded; the gate check additionally requires the matching consent when the run exercises ServiceTitan or match-key behavior and does not require it otherwise; marked samples flow into the labeled set.
```

**Tests and QA**
- Runs in staging only, no production writes.
- The gate check blocks it unless the section 0.2 processing gates are recorded (recording consent, agreements and addendum, Anthropic no-train, Anthropic retention), and additionally requires the ServiceTitan matching consent only when the run exercises that path.
- Marked samples seed the labeled set.

**Security**
- This is the one consented exception to the synthetic-only rule. It runs in staging, after all gates, and writes nothing to production.

---

#### Task 11.2: Historical backfill

**Plan mode: YES. GATED on the signed data-processing addendum.**
**Depends on: 11.1**

```text
Build the historical backfill runner. GATE: it refuses to run unless every section 0.2 processing gate is recorded in consent_gates: recording or share consent, the signed services agreement, the signed data-processing addendum, the Anthropic no-training confirmation, and the Anthropic data-retention confirmation. ServiceTitan matching consent is required only if the backfill run writes or uses match_keys. It pulls historical calls in rate-limited batches honoring both Dialpad limits, is fully resumable from backfill_runs checkpoints, and is idempotent so a re-run does not duplicate. A checkpoint write failure emits BACKFILL_CHECKPOINT_FAILED and stops cleanly so the run can resume. It drives the dedicated job-style backfill check (provisioned in Task 0.1): a start ping when a run begins, periodic progress pings on a cadence while it runs, and a terminal success ping on clean completion or a fail ping on error. Between runs the check is idle and expects nothing, so it neither alerts when no run is scheduled nor stays silent if a run stalls partway. It honors the same redaction fail-closed rules as the live pipeline. Tests: the gate blocks when any required processing gate is absent; the run starts only when all required processing gates are present; ServiceTitan matching consent is required only when match_keys are enabled; an interrupted run resumes from its checkpoint with no gaps or duplicates; both rate limits are respected; a checkpoint failure emits the right code and stops cleanly.
```

**Tests and QA**
- The gate blocks the run when any required section 0.2 processing gate is absent, and the run starts only when all are present.
- ServiceTitan matching consent is required only when match_keys are enabled.
- An interrupted backfill resumes from its checkpoint with no gaps or duplicates.
- Both rate limits are respected.
- A checkpoint failure emits `BACKFILL_CHECKPOINT_FAILED` and stops cleanly.
- A run sends one start ping when it begins.
- A run sends periodic progress pings while active.
- A clean run sends exactly one terminal success ping.
- A failed run sends exactly one terminal fail ping.
- A stalled active run triggers the backfill monitor alert.
- An idle period between backfill runs does not alert.

**Security**
- The highest-volume PII move does not start until all processing gates are recorded.

---

### Phase 12: ServiceTitan matching and write-back (gated, optional, not in the core proposal)

This phase does not start until the data-processing addendum is signed, ServiceTitan API access is confirmed, the matching-key design below is in place, and the ServiceTitan matching consent is recorded. Re-verify the current ServiceTitan API surface, including its supported webhook authentication mechanism, against their docs at build time.

#### Task 12.0: Matching-key design decision

**Plan mode: YES.** A design decision that must precede any ServiceTitan code, because Phase 8 purges the PII a naive match would need.

The conflict: matching a new ServiceTitan job back to a call needs phone number and name, but redaction and the retention job remove exactly those values. Phase 12 must not rely on data Phase 8 has purged.

The decision: do not retain raw phone or name for matching. At ingestion, compute salted HMAC hashes of the normalized phone number and name and store them in `match_keys` with their own short retention window, their own retention bookkeeping, and their own consent gate. Matching compares hashes, not raw values, and uses the call timestamp for the time-window join. Raw phone and name are still redacted and purged on the normal schedule. If Eric does not consent to retaining even hashed match keys, ServiceTitan matching is off the table and the dispatch summary is not written.

```text
Implement the match_keys design. At ingestion, after the metadata pre-filter and before purge, compute salted HMAC hashes of the normalized phone number and name and store them in match_keys with a key_version and a retention_eligible_at on a short, independent window, plus soft and hard delete timestamps. The hashing key is in secrets. match_keys is readable only by the restricted role. Add a consent gate type for ServiceTitan matching and require its presence before any match_keys row is written. The retention job purges match_keys on its own window. Tests: a match_key is written only when the matching consent gate is present; stored values are hashes, not raw; the app role cannot read match_keys; match_keys purges on its own window independent of raw transcript purge.
```

**Tests and QA**
- A match key is written only when the matching consent gate is present.
- Stored values are hashes, not raw phone or name.
- The app role cannot read `match_keys`.
- `match_keys` purges on its own window.

**Security**
- Matching uses hashes with their own consent and retention. It never depends on PII the pipeline has purged.

---

#### Task 12.1: ServiceTitan client and job.created consumer

**Plan mode: YES. GATED.**
**Depends on: 12.0, 5.3, 2.3, signed addendum, confirmed API access**

```text
GATE: confirm all four are in place before writing code: the data-processing addendum is signed, ServiceTitan API application access is enabled, the matching-key design from Task 12.0 is implemented, and the ServiceTitan matching consent is recorded. Re-verify the current ServiceTitan V2 API for the job notes endpoint and the job.created webhook, including its supported webhook authentication or signature mechanism, before writing code.
Build a ServiceTitan consumer on top of the shared Task 2.3 middleware. Verify the webhook using ServiceTitan's current supported authentication or signature mechanism. If HMAC signing is available, use it; if it is not, document the supported alternative (for example a shared secret header, OAuth-validated callback, or IP allowlist) and update the threat model accordingly. Match the new job back to a recent call by comparing salted HMAC hashes in match_keys plus a time window. Above a deterministic match threshold, write one tight dispatch summary into the job note, idempotently and additively, marked so a re-run updates rather than duplicates and never overwrites human-entered text. Below threshold, hold with reason weak_servicetitan_match and write nothing; emit SERVICETITAN_MATCH_WEAK. Never guess. Do not write emotional signals, sentiment, or confidence scores into ServiceTitan. Use OAuth2 machine-to-machine with least-privilege scopes; an auth failure emits SERVICETITAN_AUTH_FAILED and a write failure emits SERVICETITAN_WRITE_FAILED. Tests: a valid authenticated webhook with a strong hash match writes exactly one note; a weak match holds with weak_servicetitan_match and writes nothing; a re-run updates rather than duplicates; a job with existing human notes is not overwritten; no sentiment or confidence reaches ServiceTitan; auth and write failures emit the right codes.
```

**Tests and QA**
- A confident hash match writes exactly one dispatch summary, additively.
- A weak match holds with `weak_servicetitan_match` and writes nothing.
- A re-run updates rather than duplicates.
- Human-entered notes are never overwritten.
- No sentiment, emotional signal, or confidence score reaches ServiceTitan.
- Auth and write failures emit the right codes.

**Security**
- Webhook authentication uses ServiceTitan's current supported mechanism, confirmed at build time, with the threat model updated if HMAC is unavailable. Matching uses hashed keys. A silent wrong-job write is prevented by holding below threshold.

---

## 5. Test strategy summary

- **Unit**: pure logic. Pre-filter rules, redaction layers, the residual scanner, the schema and urgency gates, the failure-model formatter and dedup.
- **Integration**: the database and the queue, with Dialpad and Anthropic mocked. Idempotency, retries, dead-lettering, stage transactions, review-queue wiring, retention windows including held-call caps.
- **Contract**: Dialpad and Anthropic response shapes and their failures (429 for both rate limits, 5xx, auth failure, malformed, empty, not-yet-ready transcript, changed shape).
- **Golden fixtures**: redacted transcripts with expected classifications and extractions, fed and grown by reviewed corrections from Phase 6.3.
- **Privacy**: no-PII-egress on model input, no-PII in stored marketing phrases, no-PII in exports, no-PII in alerts, no-PII in clear in raw webhook events (allowlisted metadata only, phone or name hashed), and the labeled-corpus recall target, all enforced in CI.
- **Adversarial**: prompt injection, and redaction evasion across names, addresses, cross-streets, phones, emails, business names, and spelling and spacing variations, all failing safe.
- **Security**: the public-endpoint suite from Phase 9, run against every surface, plus a check that no surface bypasses the shared middleware.
- **Operational**: each major failure path emits exactly one actionable alert with the right code; alerts deduplicate; critical alerts escalate; boot failures name the missing dependency; per-component heartbeats alert independently.
- **Key lifecycle**: the wrapped DEK material and KEK live outside the backed-up database; rotation deletes the old DEK material in the external store and old ciphertext becomes unreadable; the decisive backup test confirms a pre-destruction backup cannot decrypt rows whose key material was later destroyed; emergency revocation makes rows at the destroyed key or KEK version unreadable in a restored copy.
- **End to end**: one synthetic call traced from webhook to stored record, in staging, before any live processing.

CI runs unit, integration, contract, golden, privacy, adversarial, and security tests on every pull request. A red privacy or security test blocks merge.

---

## 6. Launch gates and stabilization

### 6.1 Launch gates (all must pass before production or live processing)

These gates govern live processing, not the consented staging validation in Task 11.1, which runs earlier under all section 0.2 gates.

- The end-to-end synthetic call passes from webhook to stored record.
- Redaction corpus recall meets or beats the configured target.
- No-PII-egress tests pass for model input, stored marketing phrases, exports, and alerts.
- The public-endpoint security audit passes on every surface, with none bypassing the shared middleware.
- The model cost hard cap is tested and holds calls when tripped.
- Alert delivery is tested: each major failure emits one actionable alert; alerts deduplicate; critical alerts escalate; per-component heartbeats alert independently.
- Dead-letter behavior is tested, with sanitized root-cause metadata, and `alert_events`, `processing_log`, and `dead_letter` persist the full sanitized failure snapshot.
- The backup restore drill has been run, and rotation and emergency-revocation crypto-shred behavior confirmed.
- The external key-store deletion-semantics checklist and test pass: soft-delete, recovery windows, version history, replicas, backups, delayed destruction, authorization, and audit are all documented, and a destroyed key cannot be restored without an approved emergency process.
- The runbook error-code matrix is complete: every error code has a runbook entry with root cause, immediate remediation, longer-term fix, owner, and escalation path, and every alert's `runbook_ref` resolves to an existing entry.
- The held-for-review workflow is tested end to end, including reprocess without duplicates and the held-call raw-retention cap.
- The status surface is verified on a mobile screen and shows a broken state with its cause.
- All section 0.2 processing, legal, and vendor-retention gates are recorded in `consent_gates`, and the ServiceTitan matching gate if that phase is in scope.

### 6.2 Stabilization period

Stabilization is the monitored window after launch and before handover. A clean window means: no `critical` alerts, no silent failures, no PII-egress or security test regressions, the retention job ran on schedule, the per-component heartbeats stayed green, and the held-review queue did not breach its SLA.

The clock resets on any `critical` alert, any PII-egress or security regression, any silent failure discovered after the fact, or a held-review SLA breach that went unescalated. Acceptable issues that do not reset the clock: a held call the review workflow handled as designed and within SLA, a Dialpad rate-limit backoff that recovered on its own, and a transient dependency blip that self-healed and alerted correctly.

### 6.3 Runbook and handover

Write the runbook in plain language for someone who runs the business from a truck:

- How do I know it is working? Point at the status surface.
- What does each alert mean and what do I do? One line per error code.
- What is "held for review," who clears it, what is the SLA, and where?
- How do I pause it? The kill switch.
- Who do I call? OVIO contact and response window.

The runbook also contains the error-code matrix that the launch gate checks: one entry per error code, each with its root cause, immediate remediation, longer-term fix, owner, and escalation path. Every alert's `runbook_ref` must resolve to one of these entries, and a test confirms there are no dangling references and no error code without an entry.

The handover point bounds OVIO's tail liability. The system is handed over when the launch gates pass, the runbook is delivered, the per-component monitors are live, and the stabilization window has run clean. After that, operational responsibility transfers to Eric under the retainer terms.

---

## 7. Open items to confirm

- Eric's written confirmation that the calls were recorded properly and he can share them, recorded in `consent_gates`.
- The signed services agreement and data-processing addendum, recorded in `consent_gates`. Historical backfill stays locked until all section 0.2 processing gates are recorded, and the ServiceTitan phase until the addendum is recorded.
- Anthropic no-train terms confirmed and recorded.
- Anthropic's API data retention policy confirmed and recorded (inputs and outputs are generally deleted within about 30 days, with exceptions), so the privacy record captures retention as well as training. Re-confirm at build time.
- The exact legal entity name for the agreements.
- Whether ServiceTitan write-back is in the first release or stays gated. The plan assumes gated, and the phase requires all four prerequisites: signed addendum, confirmed API access, the implemented matching-key design (Task 12.0), and the recorded ServiceTitan matching consent.
- ServiceTitan's current supported webhook authentication mechanism, confirmed at build time. If HMAC is unavailable, the documented alternative and the updated threat model.
- The redaction recall target and the redaction risk threshold, set as explicit config before live processing.
- The retention windows (soft and hard) for every purgeable table, the held-call raw-retention cap, the review SLA per held reason, and the match-key retention window.
- The backup and PITR retention policy, and confirmation that crypto-shredding via key destruction is acceptable as the backup deletion control, including that emergency revocation is irreversible.
- Where the wrapped DEK material and KEK live, confirmation this store is outside Postgres backups, and confirmation of its own deletion and recovery semantics, including any soft-delete or recovery window.
- Whether Eric consents to retaining hashed match keys at all. If not, ServiceTitan matching is out.
- The scope of the minimal knowledge-base surface for first release.
- Both Dialpad rate limits confirmed against current docs.

---

## 8. Stack and model reference

- **Runtime**: Node.js, TypeScript strict, zod at boundaries, pino logging.
- **Compute**: Railway services (webhook-receiver, worker, reconciliation-cron, retention-cron) under Eric's org, each cron with its own external check.
- **Data**: Postgres (envelope-encrypted vault and raw transcripts, restricted roles, PITR), Redis (BullMQ).
- **Shared modules**: failure-model modules (Task 2.2) and hardening and auth middleware (Task 2.3), used everywhere.
- **Models**: classify on a configurable Haiku id (default `claude-haiku-4-5-20251001`), extract on a configurable Sonnet id (default `claude-sonnet-4-6`). Model id and prompt version recorded per invocation. Re-confirm current model ids at build time.
- **External**: Dialpad API (two rate limits: 1200 per minute on transcripts, 20 per second company-wide, both confirmed at build time), the external cron monitor (one check per component plus a backfill check), the alert channel, the auth provider for internal surfaces, and ServiceTitan (gated).

---

## 9. Architectural changes from the first review

- Held-for-review became a real workflow (Phase 6) with the `review_queue` and `operator_actions` tables, specific held reasons, an authenticated review surface with raw-versus-redacted visibility rules and audited actions, a safe reprocess path, and a loop that turns reviewed corrections into labeled evaluation data.
- The knowledge base became a deliverable, not just a database (Phase 10): a minimal authenticated read-only surface for search, export, and plain-language summaries, with proven PII-free exports.
- The ServiceTitan, purge, and PII conflict was resolved (Task 12.0) with salted HMAC `match_keys` that carry their own retention and consent.
- Redaction stopped claiming perfect coverage (Phase 4): a risk score with reasons, a residual-PII scan, a second scan over verbatim marketing phrases, and an adversarial corpus.
- Purge moved off the per-call path (Phase 8): the pipeline marks rows retention-eligible and a scheduled job deletes them.
- Ingestion was reordered (Phase 3): metadata pre-filter before the transcript fetch.
- Public endpoints were hardened, and operational tables, per-invocation model and prompt versions, backup reconciliation, measurable acceptance criteria, and a full operational failure model were added.
- Rate-limit and model assumptions were corrected, and a timeline risk note was added.

## 10. Architectural changes from the second review

- **Per-component heartbeats** (constraint 0.3.1, Task 7.1). One shared external check could let a healthy worker mask a dead cron. Each component now pings its own check slug on its own cadence, and a test proves a stalled reconciliation cron alerts while the worker keeps pinging.
- **The failure model is now an executable task** (Task 2.2). Section 2.7 was a specification that other tasks depended on as if it were code. Task 2.2 builds the shared error types, severity mapping, alert formatter, dedup keys, escalation, and test fixtures. The graph and dependencies now point to it.
- **Launch gates and staging validation no longer contradict** (sections 0.2, 6.1, Task 11.1). Gates now read "before production or live processing." Task 11.1 is the one consented exception, runs in staging, and requires every section 0.2 gate recorded, not just one.
- **Crypto-shredding is now precise** (constraint 0.3.4, Task 8.2). A real KEK and DEK hierarchy, a key-version lifecycle, a rotation process that destroys the old DEK only after verified re-encryption, and an emergency-revocation procedure that states exactly what becomes permanently unrecoverable. Crypto-shredding counts only once the old key material is destroyed.
- **Held calls no longer retain raw PII indefinitely** (Task 6.1). A review SLA per held reason, escalation on breach, a hard cap on raw retention for unresolved holds (after which raw and vault are purged while the redacted record and queue row survive), and an unresolvable path.
- **ServiceTitan webhook auth is conditional** (Tasks 12.0, 12.1). The plan no longer assumes HMAC. It verifies using ServiceTitan's current supported mechanism, and if HMAC is unavailable it documents the alternative and updates the threat model.
- **Retention bookkeeping is complete** (Task 1.1, section 2.4). Every purgeable table, including `raw_webhook_events` and `match_keys`, now carries `retention_eligible_at`, `soft_deleted_at`, and `hard_deleted_at`, and the retention job covers them all.
- **The knowledge-base surface no longer depends on a late audit for its hardening** (Tasks 2.3, 10.1, 9.1). A shared hardening and auth middleware (Task 2.3) is built early and consumed by every surface (3.2, 6.2, 7.3, 10.1). Phase 9 became a security audit that confirms every surface uses it, rather than the place the middleware is first built. This resolves the dependency gap: 10.1 now depends on the shared middleware, not on the consolidated pass.

## 11. Architectural changes from the third review

- **A backfill external check is now provisioned** (Task 0.1, 11.2, sections 1 and 8). Task 11.2 claimed its own check, but setup created only three. Task 0.1 now creates a fourth, a backfill check that expects pings only while a run is active, and 11.2 points at it by name.
- **Retention bookkeeping is now internally consistent for `call_state` and `redaction_findings`** (Task 1.1, section 2.4). `call_state` is indefinite, so its stray `retention_eligible_at` was removed and it is excluded from the purgeable-table test. `redaction_findings` is purged with its clean transcript, so it now carries the three retention timestamps and the retention job covers it.
- **The key registry is now explicit** (constraint 0.3.4, Task 1.1, 8.2, section 2.4). A `key_versions` table holds `key_version`, `status`, the wrapped DEK reference, and created and destroyed timestamps. The KEK never lives in the database. Destruction removes the wrapped material, and a test confirms a destroyed key version cannot decrypt its rows.
- **`raw_webhook_events` minimization is now concrete** (Task 3.2, section 2.4). "No PII beyond audit need" was too loose. The receiver now keeps an explicit allowlist of metadata fields, hashes phone or name if present, stores no message content, and a test asserts planted PII is never stored in clear.
- **Anthropic data retention is captured, not just no-training** (sections 0.2, 7, and the services table). The privacy record now confirms and records the API data retention policy alongside the no-training terms, with a build-time re-confirmation.
- **Phase 10's parallel note was corrected** (Task 10.1). It no longer claims to run alongside the security audit that depends on it. The note now reads observability only, with Phase 9 following.

## 12. Architectural changes from the fourth review

- **Crypto-shredding now actually reaches backups** (constraint 0.3.4, Tasks 1.1, 8.2, sections 2.4, 3, 5). The earlier design stored the wrapped DEK material inside Postgres, so a backup taken before deletion captured it, and with the KEK still present a restore could decrypt. Fixed: the wrapped DEK material and the KEK now live in a secret store or key service outside the Postgres backups, and `key_versions` holds only metadata and a reference, never recoverable key bytes. KEKs are versioned. The decisive new test restores a pre-destruction backup and confirms rows whose key material was later destroyed cannot be decrypted even though the KEK still exists.
- **Task 11.1's gate list is no longer stale** (Task 11.1). It now enumerates the current section 0.2 processing gates, including the Anthropic data-retention confirmation, and requires the ServiceTitan matching consent only when the validation run exercises ServiceTitan or match-key behavior.
- **The backfill monitor has an explicit contract** (Tasks 0.1, 11.2). It is now a job-style check: a start ping, periodic progress pings, and one terminal success or fail ping. Between runs it is idle and does not alert; during a run it alerts on a stall, a fail signal, or a missing terminal signal. This closes the gap where an idle check could either false-alarm or miss a stalled run.

## 13. Architectural changes from the fifth review

- **The key store's own deletion semantics are now verified** (Task 8.2, open items). Moving key material outside Postgres backups is necessary but not sufficient: the external store may itself have soft-delete, recovery windows, version history, replicas, or delayed destruction. Task 8.2 now requires confirming and documenting recoverability, recovery windows, who may destroy keys, and how destruction is audited. Crypto-shredding counts only once the key material is unrecoverable from the external store, including from soft-delete and version history, and any mandatory recovery window is documented as part of the true deletion timeline. A deletion-semantics test fails the launch gate if a destroyed key can still be restored without an approved emergency process.
- **Historical backfill gates on all processing gates** (Task 11.2). It previously gated only on the signed data-processing addendum. It now refuses to run unless every section 0.2 processing gate is recorded (recording or share consent, signed services agreement, signed data-processing addendum, Anthropic no-training, Anthropic data retention), with ServiceTitan matching consent required only if the run writes or uses match_keys.
- **The backfill monitor QA is now complete** (Task 11.2). Explicit bullets assert one start ping, periodic progress pings, exactly one terminal success or fail ping, an alert on a stalled active run, and no alert during idle periods, so the body prompt, the QA checklist, and the launch expectations line up.

## 14. Architectural changes from the sixth review

- **Backfill gating wording is consistent everywhere** (sections 0.2, 7, Task 11.2). Historical backfill is gated on all section 0.2 processing, legal, and vendor-retention gates, not the data-processing addendum alone.
- **ServiceTitan gating is stated in full at every mention** (sections 0.1, 7, Phase 12 intro, Task 12.1). The phase requires the signed addendum, confirmed API access, the implemented matching-key design (Task 12.0), and the recorded ServiceTitan matching consent.
- **The Anthropic setup checklist records retention, not just no-training** (Task 0.1). It now captures both, with the evidence URL, confirmation date, selected model IDs, account or product path, the standard retention window, and any exceptions.
- **Failure data is persisted, not just alerted** (Task 1.1, 7.4). `alert_events`, `processing_log` failure rows, and `dead_letter` each store a sanitized failure snapshot with error_code, root_cause_category, severity, impact, processing_state, remediation_now, remediation_fix, data_safe, calls_state, owner, runbook_ref, and sanitized context, so a failure is explainable after the fact.
- **The failure model proves remediation completeness** (Task 2.2). A static remediation catalog and a completeness test require every error code and root-cause category to carry a non-empty impact, immediate remediation, longer-term fix or explicit "same as immediate," data-safety status, calls-state, owner, and runbook_ref, with no generic UNKNOWN fallback passing.
- **The runbook error-code matrix is a launch gate** (sections 6.1, 6.3). Every error code must have a runbook entry with root cause, immediate remediation, longer-term fix, owner, and escalation path, and every alert's runbook_ref must resolve.
- **Key-store deletion semantics are a named launch gate** (section 6.1). The external key-store deletion-semantics checklist and test (soft-delete, recovery windows, version history, replicas, backups, delayed destruction, authorization, audit) must pass before launch.
- **"Consent gates" is renamed where it was broader than consent** (section 6.1). The launch gate now reads "processing, legal, and vendor-retention gates," recorded in the `consent_gates` table.

## 15. Architectural changes from the seventh review

- **The status surface gains a structure-plus-health pipeline view** (Task 7.3, section 2.1). A separate n8n-style frontend was considered and rejected: the reporting need is already covered by the status surface (7.3) and the knowledge-base surface (10.1), and a parallel app would duplicate scoped, hardened work and add an unproven surface during stabilization. Instead, 7.3 now renders the section 2.3 state machine and its surrounding components as a fixed diagram where each node shows a state and the count of calls sitting there, driven off signals the system already emits: `call_state.current_stage`, the per-component checks from 7.1, `review_queue` counts by held reason, the `dead_letter` count, the counters from 7.4, and `daily_cost_usage` with the kill-switch state from 7.2. It shows structure, health, and counts only, never content or PII, and a node with no signal renders as unknown rather than failing the page.
- **The live per-call execution animation is explicitly deferred** (Task 7.3). Watching a single call move node to node in real time needs event streaming and per-job state tracking, adds a surface that answers no question the counts do not, and competes with the held-for-review workflow and endpoint hardening for the two-week build bar in section 0.5. It is out of scope for the first release and gated to a later increment.
- **The knowledge-base surface PII test is tied to the second verbatim scan** (Task 10.1). The read-only surface's free-text search and export operate over the verbatim `customer_language` field, the most likely place a PII leak survives. The task now states that `customer_language` reaches the store only after passing the second PII scan in Task 5.2, that a record failing the scan is held rather than stored, and that the PII-free export test covers that field specifically against the labeled corpus.
