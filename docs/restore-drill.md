# Restore drill (Task 8.2)

A tested procedure to restore a Postgres backup into an isolated environment, verify integrity, and
confirm the **decisive crypto-shred property**: rows whose external key material was destroyed are
unreadable after restore, even though the restore is otherwise intact. **Scope: staging + the
reference `LocalFileKeyStore`, and the production Railway-secret key store (ADR 0008). The full
production drill against a dedicated external KMS remains Task 8.2b.**

## The §6.1 launch gate

The restore drill is a §6.1 launch gate for live processing. As of ADR 0008 production runs on the
Railway-secret key store (`CRYPTO_KEY_PROVIDER=railway`): `checkLaunchGate` **passes** in production
on `railway` (or a verified `kms`) and still **fails** on the dev/staging-only `keystore`/`local`
providers, on a still-recoverable destroyed version, and on a stalled destruction. It no longer
blocks production pending Task 8.2b. `docs/backup-retention.md`'s provider table must still be filled
with real, dated evidence for whichever store production uses.

## Automated proof (runs in CI/local against an isolated scratch DB)

The invariant is proven in-process by `test/key-lifecycle/backup-shred-invariant.test.ts`: a captured
pre-destruction ciphertext (a stand-in for a backup row) becomes permanently unreadable once its DEK
is destroyed, while a different version under the intact KEK still decrypts. The rotation/revocation
DB tests (`test/key-lifecycle/*.test.ts`) prove the same end-to-end against a real Postgres.

## Manual staging checklist

Preconditions — **fail the drill if any is UNKNOWN:**

- [ ] `docs/backup-retention.md` provider table filled with dated evidence.
- [ ] The external-key-store deletion-semantics checklist (`docs/key-hierarchy.md`) filled in.
- [ ] An isolated staging environment (separate DB, separate key-store directory) — never production
      data, never the production key store.

Steps:

1. **Encrypt known rows.** In staging, bootstrap a key, process (or seed) a few `raw_transcripts` +
   `token_vault` rows under a known `key_version`. Record their `call_id`s and expected plaintext.
2. **Take a backup** (PITR snapshot / `pg_dump`) of staging Postgres — the "pre-destruction backup".
3. **Rotate or revoke** so the recorded rows' `key_version` is destroyed: run `rotate-key`
   (re-encrypts then shreds the old DEK) or `revoke-key --dek <v>` (shreds in place). With a nonzero
   recovery window, advance past it and run `confirm-destruction`.
4. **Restart every DEK-caching service** (worker, review surface) so no cached unwrapped DEK survives.
5. **Restore the pre-destruction backup** into a fresh isolated DB. Confirm integrity: row counts,
   schema, non-encrypted tables intact.
6. **Prove the shred:** attempt to decrypt the recorded rows in the restored DB using the current key
   store. They **must fail** (the destroyed DEK's material is gone from the store), while a row at a
   still-live version decrypts. Confirm `store.recoverability(destroyed version) === false`.
7. **Run the launch gate** (`checkLaunchGate`): it must report no destroyed-but-recoverable version
   and no stalled destruction; in production it must still fail pending a verified KMS (8.2b).

## What this proves

The backup was intact but never contained the key material; destroying the external DEK/KEK made the
old ciphertext unreadable in the live DB **and** in the restored backup. That is crypto-shredding
reaching backups — the honest deletion promise.
