# Backup retention policy & the meaning of purge (Task 8.2)

What the live purge (Task 8.1) does and does NOT reach, and the true maximum lifetime of a purged
raw/vault row inside backups. **This is provider-sourced: the numbers below must be read off the
actual Railway/Postgres settings and dated, not assumed.** The restore-drill checklist
(`docs/restore-drill.md`) **fails if any field here is unknown.**

## Live purge vs. backup expiry

- The retention cron (Task 8.1) soft- then hard-deletes plaintext in the **live database**, and the
  held-cap pass physically `DELETE`s `raw_transcripts` + `token_vault`.
- **A Postgres PITR snapshot or backup taken _before_ a purge still contains those rows** until the
  backup window rolls off. Purge removes plaintext from the live DB; it does not reach backups.
- The deletion promise reaches backups only via **crypto-shredding** (`docs/key-hierarchy.md`): the
  wrapped DEK + KEK live outside the backed-up database, so once the external key material is
  destroyed, the ciphertext in a restored backup is permanently unreadable — even though the backup
  is otherwise intact.

## Provider-sourced retention table (REQUIRED — fill from the provider, do not guess)

| Field                                                                               | Value       | Source / evidence                         | Checked (date) | Owner    |
| ----------------------------------------------------------------------------------- | ----------- | ----------------------------------------- | -------------- | -------- |
| PITR retention (days)                                                               | **UNKNOWN** | Railway Postgres settings screenshot/link | UNKNOWN        | Platform |
| Snapshot retention (days)                                                           | **UNKNOWN** | Railway backup settings                   | UNKNOWN        | Platform |
| Snapshot cadence                                                                    | **UNKNOWN** | Railway backup settings                   | UNKNOWN        | Platform |
| **Max backup lifetime of a purged raw/vault row** (= max(PITR, snapshot) retention) | **UNKNOWN** | computed from the two above               | UNKNOWN        | Platform |
| Are backups encrypted at rest?                                                      | UNKNOWN     | provider                                  | UNKNOWN        | Platform |

> The launch checklist verifies these against the provider. Env vars only **mirror** these values;
> the provider's own settings are authoritative. A row that is live-purged is still recoverable from
> a pre-purge backup for up to the "max backup lifetime" above — after which it rolls off — OR
> immediately unreadable if its key material has been crypto-shredded, whichever comes first.

## What crypto-shredding changes

Once a DEK/KEK version is destroyed in the external store (past any recovery window), rows at that
version are unreadable in **every** backup regardless of the backup window — the shred is the
backstop that makes deletion honest before the backup window rolls off. See `docs/key-hierarchy.md`
and `docs/restore-drill.md`.
