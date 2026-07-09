# ADR 0008 — Railway secret key store and raw-store isolation

Status: accepted (2026-07-08). Implemented in two PRs. Move 1 (the Railway-secret key
store) merged on branch `task/8.2c-railway-keystore-raw-isolation`. Move 2 (raw-store
database isolation) IS this PR, on branch `task/8.2d-raw-store-db-isolation`.

## Context

ADR 0005 scoped Task 8.2 to dev/staging only: the reference `LocalFileKeyStore`, with
production live-processing blocked on Task 8.2b — a dedicated external cloud KMS (AWS
KMS, GCP KMS, or HashiCorp Vault). That remained the plan until the client asked to
simplify their footprint: going live should not require standing up and paying for a
new cloud vendor/account just to hold a key.

The one requirement that cannot bend is the crypto-shred promise from ADR 0005:
destroying key material must render even a pre-deletion Postgres backup permanently
unreadable, because the wrapped DEK material and the KEK live outside the backed-up
database. Any replacement for the external KMS has to satisfy that seam, not weaken it.

The full design — both moves, the crypto-shred rationale, and the accepted trade-off
against a hardware KMS — is spec'd in
`docs/superpowers/specs/2026-07-08-railway-secret-keystore-and-raw-store-isolation-design.md`.

## Decision — Move 1: a Railway-secret `KeyStore` (this PR)

A new `RailwaySecretKeyStore` implements the existing `KeyStore` seam
(`src/crypto/key-store.ts`) — the same interface `LocalFileKeyStore` implements, so no
call site changes. It stores the KEK and the wrapped DEKs as two versioned JSON
documents in Railway Secrets, reached through a `SecretBackend` seam:

- `EnvSecretBackend` — read-only, used by services (worker, review surface, etc.) via
  the environment Railway injects at boot.
- `RailwayApiSecretBackend` — read/write, used only by the key-lifecycle CLIs
  (`bootstrap-key`, `rotate-kek`, `rotate-key`, `revoke-key`, `confirm-destruction`),
  which mutate the Railway secret via Railway's API and then redeploy the affected
  services so they pick up the new material. Railway only loads secrets at service
  start, which matches the existing convention that key changes are CLI-driven, not
  part of normal call processing — and the redeploy also guarantees no running process
  still holds a destroyed key in memory.

`CRYPTO_KEY_PROVIDER=railway` is now accepted in production. The launch gate and
readiness checks treat it as a production-grade, DB-sourced-active-version provider —
the same `store.recoverability()`-gated launch check ADR 0005 defined, just backed by
a different store. `local`/`keystore` remain dev/staging-only, refused in production,
unchanged from ADR 0005.

The two-state, recovery-windowed destruction from ADR 0005 §2 is preserved exactly:
Phase A moves material to pending-delete and stamps the recovery window; Phase B
(`confirm-destruction`) confirms `store.recoverability() === false` before flipping
`destroyed`. For `RailwaySecretKeyStore`, Phase B now physically purges the elapsed
key material from the secret document — crypto-shred is real here, not just modeled,
proven by tests that inspect the backend document directly after destruction.

## Decision — Move 2: raw-store database isolation

`raw_transcripts` and `token_vault` — the two highest-sensitivity tables — move out of
the main database (DB-A) into a SEPARATE Railway Postgres (DB-B) whose backups are
turned OFF (or capped to about a day). The highest-sensitivity data therefore never
enters a long-lived backup at all — a physical complement to the crypto-shred promise,
not a replacement for it.

- **Two-DB layout.** DB-A keeps deep PITR/backups but now holds de-identified data
  only (`clean_transcripts`, `redaction_findings`, `structured_knowledge`,
  `review_queue`, `call_state`, audit/metrics stores) plus key METADATA
  (`key_versions` / `kek_versions` — references, no key bytes). DB-B holds
  `raw_transcripts`, `token_vault`, and a DB-B-local `raw_purge_tombstone`, with
  backups off.
- **Cross-DB foreign keys are impossible, so they are dropped (accepted).**
  `raw_transcripts.call_id → call_state` and `raw_transcripts.key_version →
key_versions` can no longer be database-enforced across two servers. Both become
  plain application-enforced logical reference columns on DB-B. A new setting
  `RAW_DATABASE_URL` points at DB-B, with its own pool family (`src/db/raw-store.ts`:
  `createRawAppPool` / `createRawRestrictedRunner` / `createRawPurgePool` /
  `createRawOwnerPool`) and its own migration set (`migrations-raw/`, run against
  `RAW_DATABASE_URL`). Boot readiness requires and probes `RAW_DATABASE_URL` wherever
  a service boots (staging/prod).
- **`raw_purge_tombstone` (DB-B-local) is the finality marker.** The old "a purged
  call can never be silently repopulated" guard used a same-DB atomic write against
  `review_queue.raw_purged_at`; with raw/vault now in a different database that guard
  could no longer be atomic or durable across the DB boundary. The finality marker
  moves INTO DB-B: the writers (`putTranscript` / `putToken`) check the tombstone in
  the same database (atomic and durable), and the held-cap purge deletes raw + vault
  and inserts the tombstone in ONE DB-B transaction. `review_queue.raw_purged_at` in
  DB-A remains only a best-effort AUDIT mirror.
- **Two-pool retention purge.** The RAW group and the held-cap pass run on DB-B; the
  "an open review blocks purge" check — previously an in-SQL `review_queue` subquery —
  becomes an application-level pre-filter against DB-A (the subquery can no longer
  cross databases). The shared advisory lock that mutually excludes purge and key
  rotation STAYS acquired on DB-A; a second advisory lock guards DB-B.
- **Key-lifecycle split.** Key rotation and emergency revocation re-encrypt raw/vault
  on DB-B, while key metadata and the shared advisory lock stay on DB-A. This is a
  plan-discovered consequence beyond the original spec: the crypto work spans both
  databases even though the key records themselves never leave DB-A.
- **Fail closed if DB-B is unreachable.** Redact holds: the raw read / vault write
  throws BEFORE any de-identified (findings/clean) write, so nothing is ever egressed
  and the call never advances. It propagates as a retryable stage failure (→ retry /
  dead-letter), identical to a mid-stage DB-A outage.
- **Go-live rules unchanged** (owned by Move 1): the launch gate, provider rules, and
  crypto-shred promise are exactly as Move 1 left them.

Only four code areas touch raw/vault and were repointed to DB-B: the redact +
fetch-transcript + mark-retention-eligible pipeline stages (worker), the review-surface
reveal + reprocess preflight, the key-lifecycle rotate/revoke, and the inspect-redaction
CLI; the scheduled retention purge runs on DB-B.

## Consequences

- **Accepted trade-off vs a hardware KMS.** We give up HSM-grade key isolation and an
  independent audit stream: the KEK is readable by anyone with Railway project admin
  access, and it lives in process memory in every service that decrypts, same as the
  `LocalFileKeyStore` reference. The audit trail for key changes is Railway's own
  secret-change history, not a dedicated KMS audit log. This is accepted because raw
  retention stays short and is backup-isolated (Move 2), Railway access is
  least-privilege, and keys are rotated on the existing schedule.
- A dedicated external KMS (Task 8.2b) is not eliminated — it remains a supported,
  drop-in future upgrade through the same `KeyStore` seam. Adopting it later requires
  a new `KeyStore` implementation and a config flip, not a redesign.
- Task 8.2b is downgraded from a launch blocker to an optional future upgrade (see the
  status update in `docs/task-8-2b-production-kms.md`); the §6.1 launch gate now
  passes on `railway` (or a verified `kms`) instead of only a verified `kms`.
- `docs/key-hierarchy.md`, `docs/backup-retention.md`, and `docs/restore-drill.md` are
  updated alongside this ADR to describe the Railway key holder and the Move 2
  two-database layout.
- **Operational: the secret-name/env-var coupling is load-bearing.** A running service
  reads key material from the env vars `CRYPTO_KEK_MATERIAL` / `CRYPTO_WRAPPED_DEK_MATERIAL`,
  but the CLIs write the Railway _variable named by_ `CRYPTO_KEK_SECRET_NAME` /
  `CRYPTO_WRAPPED_DEK_SECRET_NAME`. For a CLI write to reach services, the Railway variable
  under each `*_SECRET_NAME` must be injected as the matching `CRYPTO_*_MATERIAL` env var.
  The defaults make the name equal to the env var (`CRYPTO_KEK_SECRET_NAME=CRYPTO_KEK_MATERIAL`),
  so they are coupled with no extra wiring; overriding a `*_SECRET_NAME` requires wiring the
  correspondingly-named Railway variable into the matching `CRYPTO_*_MATERIAL` env var, or
  CLI-written material never reaches services.

See the full design spec:
`docs/superpowers/specs/2026-07-08-railway-secret-keystore-and-raw-store-isolation-design.md`.
