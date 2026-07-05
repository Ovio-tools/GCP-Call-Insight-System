# ADR 0005 — Key hierarchy, crypto-shredding, and backups

Status: accepted (Task 8.2, 2026-07-05)

## Context

Task 8.1 made the deletion promise real in the **live** database (soft/hard delete + a held-cap
physical `DELETE`). But a Postgres PITR snapshot or backup taken _before_ a purge still contains
those rows until the backup window rolls off. Task 8.2 closes that gap so deletion is honest all the
way into backups, and defines the key lifecycle precisely.

The envelope-encryption primitives already existed (`src/crypto/envelope.ts`, a `KeyProvider`
interface, `key_versions` metadata), and the spec (§0.3.4, the Encryption convention, §6.1 launch
gates) fixes the decisive design point: **the wrapped DEK material and the KEK must live OUTSIDE the
backed-up Postgres database**, or crypto-shredding does not reach backups.

## Decisions

### 1. Crypto-shredding via an external `KeyStore` seam; `LocalFileKeyStore` is dev/staging only

Key material (KEK bytes + wrapped DEKs) lives in an external store behind a `KeyStore` interface a
real KMS implements later. Postgres holds only refs + metadata (`wrapped_dek_ref`,
`external_kek_ref`), never key bytes — asserted by tests over columns, logs, errors, and events. The
reference `LocalFileKeyStore` (a 0600 KEK file + wrapped DEK files) is **never** a production store;
production is the named blocking follow-up **Task 8.2b**. `buildKeyProvider` refuses `keystore` in
production and `kms` still throws; the launch gate fails in production for any non-`kms` provider.
This keeps Task 8.2 honestly scoped to staging/reference and does not imply production is unblocked.

### 2. Two-phase, recovery-windowed, durably-modeled destruction — gate off the store, not the DB

Destruction is two-state: Phase A stamps `destroy_requested_at` + `destroy_recovery_window_until` +
`destroy_approval_ref` and calls `destroyDek`/`destroyKek` (moves material to pending-delete);
Phase B (`confirm-destruction`, or inline when the window is zero) confirms
`store.recoverability(...) === false` and flips `destroyed`. The launch gate and the finalizer key
off `store.recoverability()`, **never** the DB flag — a shred only counts once the material is truly
unrecoverable. Phase A holds the shared advisory lock (`8_100_001`, mutually exclusive with the
retention purge) and **releases before** any nonzero recovery window; Phase B reacquires it. Verify
runs at least twice (rotation's "old version empty" completeness check before the destroy request,
and the finalizer's `recoverability` confirmation before `markDestroyed`).

### 3. Single-active enforcement, DB-sourced active version, crash-resumable rotation

Partial unique indexes enforce one active DEK and one active KEK; `getActiveKeyVersion`/`getActiveKek`
fail loudly on zero/multiple. The keystore provider reads the active version from the DB (short-TTL
cached), so a rotation is picked up without a redeploy (`CRYPTO_ACTIVE_KEY_VERSION`/`CRYPTO_KEK_VERSION`
are bootstrap/seed only). Rotation flips active BEFORE the re-encryption sweep, is crash-resumable
(continues an interrupted `rotating` version), and refuses to start while a prior destruction is
unfinished. A `keystore`-mode service fails to boot until `bootstrap-key` seeds exactly one active
KEK + DEK.

### 4. Queue-safe maintenance pause that never burns a retry

Rotation pauses consumption **globally via `queue.pause()`** (the CLI has no local `Worker`), sets a
Redis maintenance flag, and drains in-flight jobs. The processor's defensive backstop re-delays an
already-fetched job with `moveToDelayed` + `DelayedError` — so BullMQ neither completes nor fails it
and **does not increment `attemptsMade`** (a required regression test). Rotation aborts safely on a
drain timeout (releases locks, resumes the queue, emits `KEY_ROTATION_FAILED`).

### 5. Least-privilege metadata role; ciphertext via the existing runners

A column-scoped `key_admin_role` (migration 016) may touch key metadata + the audit log only — it is
**never** granted `raw_transcripts`/`token_vault` access. Rotation reaches ciphertext through the
existing app pool (raw) and `RestrictedRunner` (vault). Emergency destructive commands require
runtime approval (`--actor`, `--approval-ref`, a typed confirmation phrase) and a config kill switch
(`CRYPTO_KEY_DESTROY_COMMANDS_ENABLED`, enable/disable only — never the approval); only
`confirmation_matched` is persisted, never the raw phrase.

## Consequences

- The deletion promise reaches backups: destroying external key material makes a pre-purge backup's
  rows permanently unreadable, proven by the backup-shred invariant + restore-drill tests.
- Production live processing stays blocked until Task 8.2b delivers a verified KMS and flips the
  launch gate. `match_keys` HMACs are excluded from rotation (a Task-12.0 tension).
- Rewrapping existing DEKs under a rotated KEK is deferred to Task 8.2b.
