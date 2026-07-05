# Task 8.2b — Production KMS provider + real-KMS deletion-semantics verification

Status: **OPEN — blocking follow-up to Task 8.2.** Task 8.2 delivers the key hierarchy, lifecycle,
launch gate, restore drill, and tests for **dev + staging only**, backed by the reference
`LocalFileKeyStore`. This task makes production live-processing ready. **The §6.1 launch gates for
live processing MUST NOT pass until 8.2b lands.**

## Why this is separate

`LocalFileKeyStore` (Task 8.2) is a faithful reference of the `KeyStore` seam: KEK bytes + wrapped
DEK files on disk, a two-state recovery-windowed destruction, and a launch gate that keys off
`store.recoverability()`. It is **not** a production secret store — a local directory is not
durable, access-controlled, replicated, or auditable the way a real KMS is, and its "deletion" is a
file unlink rather than a KMS destroy with the vendor's own recovery/version-history semantics.

`buildKeyProvider` refuses `keystore` in `production`; `CRYPTO_KEY_PROVIDER=kms` still throws; and
`checkLaunchGate` fails in production for any provider other than a verified `kms`. Those guards are
the tripwires that keep production blocked until this task flips them.

## Scope / deliverables

- **A production `KeyStore` implementation** (e.g. AWS KMS + Secrets Manager, GCP KMS, HashiCorp
  Vault) satisfying the existing `src/crypto/key-store.ts` interface: `createKek`/`getKek`/
  `destroyKek`, `createDek`/`unwrapDek`/`destroyDek`, and `recoverability({type,...})` mapped onto
  the vendor's real pending-deletion window.
- **Wire the `kms` branch** in `keyStoreFromConfig` / `buildKeyProvider` (remove the throw); allow
  `keystore` only in dev/staging.
- **Real-KMS deletion-semantics confirmation** (the §6.1 checklist, verified against the live
  service, not documented from the manual):
  - the mandatory pending-deletion / recovery window and its exact length;
  - no alternate restore path — replicas, HSM backups, key version history, multi-region copies;
  - who is authorized to destroy key material, and how destruction is audited by the vendor;
  - every DEK-caching service (worker, review surface) restarted after a revocation so no process
    holds a cached unwrapped DEK past the shred.
- **Flip the launch gate**: production passes once a verified external KMS is configured, instead of
  always failing.
- **Full restore drill end-to-end** against a production-like backup + the real KMS (see
  `docs/restore-drill.md`), proving a pre-destruction backup cannot decrypt rows whose DEK material
  was later destroyed in the KMS.
- **Rotation concurrency/crash hardening** (deferred residuals from the dev/staging reference; the
  swap is already deferred until after the sweep and committed with the destroy-request, so a crash
  now leaves a resumable `rotating` state or a `confirm-destruction`-pending state rather than an
  orphaned old version — but two narrow windows remain):
  - **Cross-process active-version cache invalidation.** Each worker's `KeyStoreProvider` caches the
    DB-sourced active version for a short TTL. Rotation invalidates only its own provider; a worker
    resuming from the pause with a sub-TTL-stale cache could still write under the old version. The
    queue now stays paused through the destroy-request (closing the zero-window case), but for a
    nonzero window a stale-cache write during the window would be shredded at finalize. Fix: signal
    active-version invalidation across processes (or make the worker re-read on maintenance clear /
    set its active-version TTL to 0 during maintenance).
  - **Crash between the swap/destroy-request commit and `destroyDek(old)`.** The DB marks the old
    version destroy-requested but the store never received the request, so `confirm-destruction`'s
    `recoverability` check keeps it pending forever. Fix: have `confirm-destruction` (idempotently)
    re-issue `destroyDek` for any DB-destroy-requested version whose store material is not yet
    pending, before checking recoverability. Also resume the maintenance pause after such a crash.

## Acceptance criteria

- Production boots with `CRYPTO_KEY_PROVIDER=kms` and a verified KMS; `keystore`/`local` remain
  refused in production.
- The decisive backup test passes against the real KMS: destroyed-version rows are unreadable in a
  restored backup once the KMS reports the material unrecoverable (past any recovery window).
- The launch gate passes in production only with the verified KMS; it still fails on a stalled
  destruction and on a still-recoverable destroyed version.
- The deletion-semantics checklist is filled in with real, dated evidence from the KMS.

## Owner

Platform (crypto/keys). Coordinate with whoever owns the Railway/cloud KMS procurement.
