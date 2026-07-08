# Design: Simpler key protection with Railway Secrets + a separate store for raw call data

Date: 2026-07-08
Status: Approved design, ready for an implementation plan
Related: ADR 0005 (key hierarchy & crypto-shredding), Task 8.2 / 8.2b (production key store)

---

## In one sentence

Instead of adding a new outside vendor (a cloud "key manager") to go live, we keep
the secret key inside the tools the client already owns — **Railway** — and we move
the most sensitive call data into its **own separate database that is never included
in long-term backups**. Together these two changes let the client launch with no new
services, while keeping the promise that deleted data is truly gone.

---

## Why we are doing this

Every customer call is scrubbed of private details (names, phone numbers, addresses)
before anything is analysed. But for a short window, the system still holds the
**original, unscrubbed transcript** — because it needs it to do the scrubbing and to
let a person double-check a flagged call. That original text is encrypted (locked)
while it is stored.

The important promise the system makes is: **when we delete a customer's data, it is
actually gone — even from old backup copies of the database.** The trick that makes
this true is that the data is locked, and the *key* to unlock it is kept somewhere
that never ends up inside a backup. Destroy the key and every backup copy of that
data turns into meaningless scrambled text. This is called "crypto-shredding."

The original plan said the key must live in a dedicated cloud "key manager" (AWS KMS,
Google KMS, or HashiCorp Vault). That is the gold standard, but it means opening and
running a whole new cloud account for the client — extra cost, extra setup, extra
thing to look after. The client asked for a simpler footprint.

**Our answer, in two moves:**

1. **Keep the key inside Railway** (the platform the client already uses), stored as a
   protected "secret" value — no new vendor.
2. **Put the raw, unscrubbed data in its own separate database whose backups are turned
   off** — so the most sensitive data never sits inside a long-lived backup in the
   first place.

Because of move #2, move #1 does not have to work as hard. The raw data is short-lived,
it is not in any long backup, and it is locked — so keeping the key in Railway is more
than strong enough to keep the "deletion is real" promise.

---

## Move 1: Keep the key in Railway (instead of a new cloud key manager)

### What this means in plain terms

Railway lets you store protected "secret" values (like passwords) that are hidden from
normal view and kept out of the code and out of the database. We store the master key
there. The running system reads it when it starts up, uses it to lock and unlock data,
and never writes it into any database.

### How it fits what already exists

The system was already built with a clean "slot" for the key holder — a defined set of
actions any key holder must support: create a key, hand it over to unlock data, and
destroy it. There is already a reference version of this slot that keeps keys in files
on disk (used for development only). We are adding a new version of that same slot that
keeps keys in Railway Secrets instead. Nothing else about how data is locked changes.

### The details (for the implementer)

- A new key-holder called `RailwaySecretKeyStore` that implements the existing
  `KeyStore` interface in `src/crypto/key-store.ts`. It is the Railway equivalent of the
  existing `LocalFileKeyStore` — same behaviour, different storage.
- Two Railway secrets hold the key material as small version-labelled lists:
  - The **master keys** (called KEKs), e.g. `CRYPTO_KEK_MATERIAL`.
  - The **wrapped data keys** (called DEKs), e.g. `CRYPTO_WRAPPED_DEK_MATERIAL`.
    There are only a handful of these over the system's life (a new one each time keys
    are rotated), so they fit comfortably in a secret value.
- The database still stores **only labels and pointers** about keys
  (`key_versions`, `kek_versions`) — never the actual key bytes. This is unchanged.
- A new setting value, `CRYPTO_KEY_PROVIDER=railway`, selects this key holder. It is the
  version that is **allowed to run in production**. The older file-based and
  development-only options stay limited to development and staging.

### Deleting a key safely (with an "undo" window)

Editing a Railway secret is instant and permanent, but destroying a key is a serious
action, so we keep the same safety net the system already has: when a key is marked for
destruction, it is first moved to a "pending deletion" holding area with a countdown
timer. During the countdown it can still be recovered. Once the timer passes, it is
gone for good. This mirrors the existing behaviour exactly — only the storage location
is different.

### One practical quirk, and how we handle it

Railway only loads secret values when a service **starts up** — it will not notice a
secret you change while it is running. That actually matches how the system already
does key work: key changes (setup, rotation, emergency destruction) are run as separate
**command-line tools**, not during normal call processing. So the flow is:

1. A command-line tool changes the key in Railway (via Railway's own control interface).
2. The tool restarts the affected services so they pick up the change.
3. This restart is also required for safety anyway — it guarantees no running service is
   still holding an old, now-destroyed key in memory.

The existing "pause the work queue during key changes" safeguards stay in place, so no
call is ever processed in the middle of a key swap.

### What we are honestly giving up (and why it's acceptable)

A dedicated cloud key manager keeps the key inside tamper-resistant hardware and records
a detailed, independent log of every use. The Railway approach does not do that — the
key can be read by anyone with Railway administrator access, and the record of changes
is Railway's normal secret-change history. We accept this because:

- The raw data is only kept for a **short** time.
- The raw data is in a **separate database with no long backups** (Move 2).
- Access to Railway is limited to few people (least privilege), and keys are rotated.

If the client ever needs the gold-standard hardware key manager (for example, an auditor
requires it), it can be added later by filling the same "slot" — no redesign needed.

---

## Move 2: A separate database for raw data, with backups turned off

### What this means in plain terms

Today all data lives in one database, and Railway backs up that whole database. We split
it into **two** databases:

- **Main database (DB-A):** everything that is already scrubbed and safe — the call
  records, the searchable knowledge base, the review history, and so on. This one keeps
  **full, deep backups** (about 30 days of history), because it contains no private
  details worth protecting that way.
- **Raw-data database (DB-B):** holds **only** the two most sensitive tables — the
  original transcripts and the private-value vault. This database has its **backups
  turned off** (or kept to about a day at most). So the raw private data never enters a
  long-lived backup at all.

### Why split it instead of just shortening all backups

Railway backs up a whole database at once — you cannot back up some tables and skip
others. If we simply shortened backups on the single database, we would lose the deep
backup history for the valuable, safe knowledge base too. Splitting into two databases
lets us keep strong backups where they help and turn them off only where the private
data lives.

### The layered guarantee this creates

The raw private data is now protected three ways at once:

1. It lives **only** in DB-B, which has no long backups — so it never enters a durable
   backup.
2. It is **encrypted (locked)** — so even a copy of DB-B, or its one-day backup, is
   scrambled text.
3. The key that unlocks it lives **only in Railway Secrets** — destroy that key and
   every locked copy everywhere becomes unreadable.

### The details (for the implementer)

- A new setting `RAW_DATABASE_URL` points to DB-B, with its own dedicated connection.
  In staging and production this is required; if it is missing, the system refuses to
  start and says exactly which value is missing.
- Only two tables move to DB-B: `raw_transcripts` and `token_vault`. Everything else
  stays in DB-A.
- The few parts of the system that touch raw data are pointed at DB-B: the scrubbing
  step (which writes it), the "show original" button in the review screen (which reads
  it), the historical import tool (which writes it), and the deletion job (which removes
  it). Every other part is untouched.
- DB-B gets its own restricted access role and permissions, mirroring how the raw tables
  are locked down today. The key-administrator role still never has access to raw data.
- Database setup scripts (migrations) are split: DB-B gets its own set that creates its
  two tables and their permissions; DB-A's set no longer creates them. Because the system
  is not live yet, this is a clean reorganisation, not a data move.
- The key-label tables (`key_versions`, `kek_versions`) **stay in DB-A** — they hold no
  secrets, so they belong with the safely-backed-up records. A raw row in DB-B simply
  carries a version number that points to them.

### How deletion works across two databases

The scheduled clean-up job (which is the only place data is ever deleted) now works like
this for raw data:

- Each raw row in DB-B has its own "eligible for deletion after this date" stamp.
- Before deleting a raw row, the job checks the **main database (DB-A)** to make sure
  the call is not still waiting on a human review.
- If it is safe, it deletes the raw row from DB-B.

This is two steps across two databases, without a single combined transaction — and that
is fine, because deletion can be safely retried and the check always errs on the side of
caution: if anything is uncertain, it does not delete and simply tries again next time.
This actually makes the raw clean-up **simpler** than before, because raw data is now the
short-lived "leaf" that nothing else depends on.

### Keeping the "never bring deleted data back" guarantee (finality marker)

Today the system has a strict promise: once a call's original data is permanently deleted,
the scrubbing step can **never** accidentally re-create it. That promise is currently
enforced by doing the delete and recording "this call is permanently gone" **together, in
one all-or-nothing step**, in the same database. Splitting raw data into DB-B would break
that, because the "permanently gone" record lives with the review information in DB-A and
you cannot do a single all-or-nothing step across two separate databases.

To keep the promise intact, we move the small **"permanently gone" marker into DB-B**,
right next to the data it protects (a tiny `raw_purge_tombstone` record keyed by call).
Then:

- When the deletion job removes a call's raw data, it also writes that call's "gone"
  marker **in the same DB-B step** — all-or-nothing again.
- The scrubbing step checks that **DB-B** marker before it writes; if the call is marked
  gone, it refuses — same database, so the check is exact and race-free.
- The equivalent stamp in DB-A (on the review record) is kept too, but only as a
  best-effort audit copy for reporting — it is no longer what enforces the guarantee.

The result: the strongest privacy guarantee (a deleted call can never be silently
repopulated) is preserved exactly, and it now lives with the data it protects rather than
across a database boundary.

### If the raw database is unavailable

If DB-B cannot be reached, the system **fails safe**: a call that cannot have its raw
data safely stored is **held**, not pushed forward. Nothing is ever sent for analysis
without its original data being safely locked away first. This keeps the existing
privacy posture.

---

## What changes in the "go-live" rules

The system currently has a hard rule that **blocks production** unless a dedicated cloud
key manager is configured. That rule was a deliberate placeholder (called Task 8.2b).
With this design:

- The go-live check is updated to **pass when the Railway key holder is properly
  configured** in production. The development-only key options are still blocked in
  production.
- Task 8.2b (the dedicated cloud key manager) is **downgraded from a launch blocker to
  an optional future upgrade.** It remains a supported path if it is ever needed.
- The project notes that currently say "production is blocked until a cloud key manager
  is added" are corrected to point at this design instead.

---

## How we will prove it works (testing)

- **Key holder behaviour:** tests that the Railway key holder correctly locks, unlocks,
  and destroys keys, including the "undo window," using a fake in-memory secret store and
  a controllable clock (mirroring the existing file-based key holder's tests).
- **"Deletion is real" proof:** lock a raw row, destroy its key, and confirm the row can
  no longer be unlocked — it is now unreadable everywhere.
- **Separation check:** an automatic test confirming the two raw tables exist **only** in
  the raw database and are **absent** from the main database.
- **Cross-database deletion:** confirming a raw row is only deleted after the main
  database says it is safe, and that the clean-up behaves cautiously if that check cannot
  be completed.
- **Go-live check:** production passes with the Railway key holder, and is refused with a
  development-only key option.
- **Key rotation & emergency destruction:** the existing key-lifecycle tests re-run
  against the Railway key holder.
- **Unchanged safety nets:** the existing "no private data ever leaves" and scrubbing-
  quality tests must all stay green.
- **Test setup note:** database tests will need a second test database address
  (`TEST_RAW_DATABASE_URL`); without it, the raw-database tests simply skip, the same way
  database tests behave today.

---

## What this design deliberately does NOT change

- How scrubbing, classification, or extraction work.
- How data is locked (the encryption method itself is unchanged).
- Anything about the scrubbed, searchable knowledge base.
- The legal/consent gates that must still be recorded before any real customer data is
  processed. Those remain separate and required.

---

## The trade-off, stated plainly

We are choosing **a simpler, cheaper setup that the client fully owns** over the
**absolute gold-standard key protection** of a dedicated cloud key manager. The "deleted
data is truly gone" promise is fully kept, because the raw data is short-lived, kept out
of long backups, and locked. What we give up is hardware-grade key isolation and an
independent audit log of key use — acceptable given the safeguards above, and upgradeable
later without redesign.

---

## Documentation to produce alongside the build

- A new decision record: `docs/adr/0008-railway-secret-key-store-and-raw-store-isolation.md`,
  capturing both moves and the accepted trade-off.
- Updates to `docs/backup-retention.md`, `docs/key-hierarchy.md`, and
  `docs/restore-drill.md` to describe the two-database layout and the Railway key holder.
- Correcting the CLAUDE.md and Task 8.2b notes about production being blocked.
