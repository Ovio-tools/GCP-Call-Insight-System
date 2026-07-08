# Task 8.2b — Production KMS provider + real-KMS deletion-semantics verification

Status: **OPTIONAL FUTURE UPGRADE (no longer a launch blocker).** Production key custody is now
provided by the Railway-secret key store (ADR 0008 / `CRYPTO_KEY_PROVIDER=railway`). A dedicated
external KMS remains a supported drop-in upgrade via the same `KeyStore` seam, but is not required
to go live. The launch gate now passes on `railway`.

The rest of this document is retained as implementation guidance for that future upgrade: what a
production `KeyStore` needs to satisfy, and the deletion-semantics checklist to verify against a
real KMS if/when one is adopted.

## Why this is separate

`LocalFileKeyStore` (Task 8.2) is a faithful reference of the `KeyStore` seam: KEK bytes + wrapped
DEK files on disk, a two-state recovery-windowed destruction, and a launch gate that keys off
`store.recoverability()`. It is **not** a production secret store — a local directory is not
durable, access-controlled, replicated, or auditable the way a real KMS is, and its "deletion" is a
file unlink rather than a KMS destroy with the vendor's own recovery/version-history semantics.

`buildKeyProvider` refuses `keystore` in `production` and `CRYPTO_KEY_PROVIDER=kms` still throws;
`checkLaunchGate` now passes in production on `railway` (ADR 0008) or a verified `kms`. Those guards
no longer block production — they keep the dev/staging-only `keystore`/`local` providers out of
production and gate the not-yet-implemented `kms` path this task would add.

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
- **Extend the launch gate to `kms`**: production additionally passes with a verified external KMS
  configured (it already passes on `railway` per ADR 0008).
- **Full restore drill end-to-end** against a production-like backup + the real KMS (see
  `docs/restore-drill.md`), proving a pre-destruction backup cannot decrypt rows whose DEK material
  was later destroyed in the KMS.
- **Validate the rotation concurrency/crash safeguards against the real KMS.** Two windows are
  already closed in the dev/staging reference and must be re-verified once the KMS timing/semantics
  differ from `LocalFileKeyStore`:
  - **Stale active-version cache on resume** — closed by a settle-wait
    (`KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS`) that keeps the queue paused past the active-version
    cache TTL. This is a _time-based_ guarantee that assumes a bounded, uniform TTL across all
    encrypting services; confirm the deployed TTL and settle value hold, and consider an explicit
    cross-process invalidation signal if a KMS-backed provider caches differently.
  - **Crash between the destroy-request commit and the store destroy call** — self-healed by
    `confirm-destruction` idempotently re-issuing `destroyDek`/`destroyKek` before the recoverability
    check. Verify the production KMS's destroy call is likewise idempotent and that its
    `recoverability` mapping reports pending correctly after a re-issue. (A maintenance pause left
    set by such a crash is still cleared manually — automating that resume is optional hardening.)

## Acceptance criteria

- Production boots with `CRYPTO_KEY_PROVIDER=kms` and a verified KMS; `keystore`/`local` remain
  refused in production.
- The decisive backup test passes against the real KMS: destroyed-version rows are unreadable in a
  restored backup once the KMS reports the material unrecoverable (past any recovery window).
- The launch gate passes in production with the verified KMS (alongside `railway`); it still fails
  on a stalled destruction and on a still-recoverable destroyed version.
- The deletion-semantics checklist is filled in with real, dated evidence from the KMS.

## Owner

Platform (crypto/keys). Coordinate with whoever owns the Railway/cloud KMS procurement.
