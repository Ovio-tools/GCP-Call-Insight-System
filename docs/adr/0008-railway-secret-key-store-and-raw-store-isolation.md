# ADR 0008 — Railway secret key store and raw-store isolation

Status: accepted (2026-07-08). Implemented in two PRs on branch
`task/8.2c-railway-keystore-raw-isolation`: Move 1 (this key store) lands in this PR;
Move 2 (raw-store database isolation) is a separate follow-up PR, not in this branch.

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

## Decision — Move 2: raw-store database isolation (follow-up PR)

A separate follow-up PR moves `raw_transcripts` and `token_vault` — the two most
sensitive tables — into their own Railway Postgres database with backups turned off
(or capped to about a day), while everything else stays in the existing, fully
backed-up database. A DB-local `raw_purge_tombstone` in that database preserves the
existing "a purged call can never be silently repopulated" finality guarantee without
a cross-database transaction. See the spec for the full design (cross-database
deletion ordering, fail-safe-hold behavior if the raw database is unreachable, and the
migration split); it is not detailed further here since it is a separate PR.

## Consequences

- **Accepted trade-off vs a hardware KMS.** We give up HSM-grade key isolation and an
  independent audit stream: the KEK is readable by anyone with Railway project admin
  access, and it lives in process memory in every service that decrypts, same as the
  `LocalFileKeyStore` reference. The audit trail for key changes is Railway's own
  secret-change history, not a dedicated KMS audit log. This is accepted because raw
  retention stays short and (once Move 2 lands) is backup-isolated, Railway access is
  least-privilege, and keys are rotated on the existing schedule.
- A dedicated external KMS (Task 8.2b) is not eliminated — it remains a supported,
  drop-in future upgrade through the same `KeyStore` seam. Adopting it later requires
  a new `KeyStore` implementation and a config flip, not a redesign.
- Task 8.2b is downgraded from a launch blocker to an optional future upgrade (see the
  status update in `docs/task-8-2b-production-kms.md`); the §6.1 launch gate now
  passes on `railway` (or a verified `kms`) instead of only a verified `kms`.
- `docs/key-hierarchy.md`, `docs/backup-retention.md`, and `docs/restore-drill.md` are
  updated alongside this ADR to describe the Railway key holder and (for Move 2) the
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
