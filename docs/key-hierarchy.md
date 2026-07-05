# Key hierarchy, rotation, and revocation (Task 8.2)

How `raw_transcripts` and `token_vault` are envelope-encrypted, how keys live and die, and why that
makes the deletion promise reach backups (crypto-shredding). **Scope: dev + staging, backed by the
reference `LocalFileKeyStore`. Production requires a real KMS — Task 8.2b.**

## The hierarchy

```
KEK (root wrapping key, external store)  ──wraps──▶  DEK v1, DEK v2, … (external store)
                                                         │ each DEK encrypts rows at its key_version
                                                         ▼
raw_transcripts / token_vault rows:  ciphertext + key_version   (Postgres)
key_versions:  key_version, status, wrapped_dek_ref, kek_version, timestamps   (Postgres — NO key bytes)
kek_versions:  kek_version, status, external_kek_ref, timestamps               (Postgres — NO key bytes)
```

- **KEK** — the root wrapping key. Stored as raw secret bytes in the external store (the
  `LocalFileKeyStore` directory, a strict-0600 file). It wraps every DEK. There is no further
  wrapping layer above it.
- **DEK** — a per-version data key, wrapped by its KEK (AES-256-GCM), stored as a wrapped file in the
  external store. Each encrypted row records the `key_version` its DEK encrypted it under; the AAD
  binds ciphertext to `v{keyVersion}` + `call_id`.
- **Postgres holds refs + metadata only.** `key_versions.wrapped_dek_ref` and
  `kek_versions.external_kek_ref` are pointers into the external store — **never key bytes.** A
  Postgres backup therefore contains ciphertext but no key material.

**The invariant that makes shredding honest:** no key bytes ever live in Postgres, logs, errors, or
`key_lifecycle_events`. The external store legitimately holds the KEK secret + wrapped DEKs (that is
its job, and it sits outside Postgres backups). Destroying a version's external material makes its
rows unreadable everywhere — live DB and every backup — even though the backups are otherwise intact.

## Single-active invariant

Exactly one `key_versions` row is `status='active'` and exactly one `kek_versions` row is
`status='active'`, enforced by partial unique indexes (migration 016). `getActiveKeyVersion` /
`getActiveKek` fail loudly on zero (bootstrap needed) or multiple (corruption). The keystore provider
reads the active version from the DB (short-TTL cached), so a rotation is picked up without a redeploy.
`CRYPTO_ACTIVE_KEY_VERSION` / `CRYPTO_KEK_VERSION` are bootstrap/seed only.

## Lifecycle: statuses

`active → retired → destroyed` for DEKs (`rotating` is the transient new-version state during a
rotation); `active → retired → destroyed` for KEKs. Destruction is durably two-state:
`destroy_requested_at` + `destroy_recovery_window_until` + `destroy_approval_ref` are stamped at the
request; `destroyed_at` + `status='destroyed'` flip **only** once the store reports the material
unrecoverable.

## Bootstrap

`node dist/scripts/bootstrap-key.js --actor ops@x --approval-ref JIRA-123` — one-time seed of the
first active KEK + DEK before any service encrypts in `keystore` mode. Refuses to run twice. A
`keystore`-mode service (`assertKeyLifecycleReady`) fails to boot until exactly one active KEK + DEK
exist.

## KEK rotation (rekey)

`node dist/scripts/rotate-kek.js --new-kek-version kek-2 --actor ops --approval-ref JIRA-123` —
activates a new KEK (old `active → retired`, new `→ active`); new DEKs are created under the new KEK.
The **retired KEK stays usable** for unwrapping its existing DEKs and is NOT destroyed until every DEK
under it is destroyed. **Rewrapping existing DEKs under the new KEK is deferred to Task 8.2b.**

## DEK rotation

`node dist/scripts/rotate-key.js --actor ops --approval-ref JIRA-123 --confirm ROTATE-KEYS`
(gated by `CRYPTO_KEY_DESTROY_COMMANDS_ENABLED`). Under the shared advisory lock (`8_100_001`,
mutually exclusive with the retention purge):

1. Allocate the next `key_version` (no row yet) → `createDek` → insert the `rotating` metadata row.
   **If the insert fails, the orphaned external DEK is `destroyDek`-compensated.**
2. Atomic swap in one tx: old `active → retired`, new `rotating → active` (retire FIRST, so the
   single-active index is never transiently violated). Invalidate the provider cache.
3. **Maintenance pause** (below), drain in-flight jobs.
4. Re-encrypt raw + vault old→new (`decrypt(old) → encrypt(new)`, exact `call_id` AAD; soft-deleted
   rows included, tombstones excluded).
5. **Verify** no recoverable ciphertext at the old version:
   `key_version=$old AND hard_deleted_at IS NULL AND octet_length(ciphertext) > 0`.
6. Mark destroy-requested (recovery window) + `destroyDek(old)` + audit events; release the lock.
7. **Phase B** (`confirm-destruction`) after the window, or inline when the window is zero.

## The maintenance pause (queue-safe)

Rotation has no local `Worker`, so it pauses **globally via the `Queue` connection**
(`queue.pause()`, Redis-backed — every worker stops fetching), sets a Redis maintenance flag, and
polls the active-job count until in-flight jobs drain. The worker processor keeps a **defensive
backstop**: for a job it already fetched, if it sees the flag it calls `job.moveToDelayed(ts, token)`
and throws `DelayedError`, re-delaying the job **without incrementing `attemptsMade`** and without
completing/failing it. Rotation **times out safely** (`KEY_ROTATION_DRAIN_TIMEOUT_MS`) — aborts,
releases locks, resumes the queue, emits `KEY_ROTATION_FAILED`. **Scale-to-zero alternative:** scale
the worker to zero replicas before rotating and back up after; the backstop then never fires.

## Emergency revocation (DEK vs KEK)

`node dist/scripts/revoke-key.js --dek 3 --actor ops --approval-ref JIRA-9 --confirm REVOKE-DEK-3`
or `--kek kek-2 … --confirm REVOKE-KEK-kek-2` (gated by `CRYPTO_KEY_DESTROY_COMMANDS_ENABLED`).

- **DEK revocation** targets one `key_version` (must be `retired` — rotate away from an active key
  first): mark destroy-requested → `destroyDek` → `revoke_dek` event → Phase B.
- **KEK revocation** targets a `kek_version`: enumerate **every `key_versions` row under it**, mark
  each destroy-requested + `destroyDek`, then `markKekDestroyRequested` + `destroyKek` →
  `revoke_kek` event with cross-version raw+vault counts → Phase B. The active key must not be under
  the target KEK (rotate the KEK + key away first).

Unlike rotation, revocation does **not** re-encrypt — it destroys the key and leaves the (now
unreadable) rows in place.

## External-key-store deletion-semantics checklist

Before treating a destruction as a real shred, confirm and record for the store/KMS:

- [ ] Can deleted key material be restored? (soft-delete, recovery window, version history, replicas,
      HSM backups, delayed destruction)
- [ ] The exact **mandatory recovery window** — the true deletion timeline. `LocalFileKeyStore` models
      it via `KEY_STORE_RECOVERY_WINDOW_DAYS`; a real KMS has its own (record it).
- [ ] Is emergency revocation immediate or delayed?
- [ ] Who is authorized to destroy key material, and how is destruction audited (vendor-side)?
- [ ] **Every DEK-caching service restarted** after a revocation — crypto-shred is not real while a
      process holds a cached unwrapped DEK. Provider DEK caches are TTL-bounded; the true-deletion
      timeline includes a redeploy/restart of the worker and review surface.

Crypto-shredding only counts once `store.recoverability(...)` reports the version unrecoverable —
including past any recovery window. The launch gate keys off that, never the DB flag.

## true-deletion timeline (summary)

`destroy_requested_at` (T0) → recovery window elapses (T0 + window) → `confirm-destruction`
confirms `recoverability=false` → `markDestroyed` → **all DEK-caching services restarted** → the row
is unreadable in the live DB and in every backup taken at any time.

## `match_keys`

`match_keys` HMACs are one-way and excluded from re-encryption and the verify predicate. Destroying a
version breaks _future_ ServiceTitan matching (recompute is impossible), not readability. Flagged as a
Task-12.0 tension.

**`LocalFileKeyStore` is never a production store.** Production is Task 8.2b
(`docs/task-8-2b-production-kms.md`).
