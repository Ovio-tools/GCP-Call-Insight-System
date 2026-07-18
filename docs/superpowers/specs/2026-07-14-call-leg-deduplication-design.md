# Call-leg deduplication — design

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Area:** reconciliation ingest, fetch-transcript stage, knowledge-base read model

## Problem

Recent calls appear **twice** in the Knowledge base surface. Confirmed with a real
pair of `structured_knowledge` rows: `call_id` `4591131021746176` and
`6643403700510720` — two rows for one ~83-second inbound conversation.

`structured_knowledge.call_id` is the PRIMARY KEY and the write is an upsert on
`call_id`, so the table cannot hold two rows for one id, and the KB list/query do not
fan rows out. Therefore a call showing "twice" means **two distinct `call_id` values
for the same underlying conversation** each ran the pipeline to completion.

### Root cause (confirmed, not theorized)

A Dialpad conversation is modeled as multiple **legs** (a master call plus
operator/transfer legs), each with its own id. Evidence from the confirmed pair:

- Both rows were ingested by the **reconciliation cron** (`source =
  dialpad-reconciliation`), in the **same sweep** (`created_at` identical to the
  second), both `completed`.
- `GET /api/v2/call` (the list endpoint the cron uses) returns **each leg as its own
  item** with its own `call_id`, and does **not** expose any field linking the legs.
- The cron's `seen` set only dedups identical id strings, so two different leg ids
  both pass (`src/reconciliation/run.ts`).
- The metadata pre-filter can drop a non-operator leg only when the call metadata
  carries `is_internal` + `operator_call_id`; the cron seeds only
  `{state, direction, duration}`, so the pre-filter **fails open** and processes
  every leg (`src/pipeline/metadata-prefilter.ts:59-63`).

The only place the legs are linked is the **transcript response**: `GET
/api/v2/transcripts/{legId}` returns a top-level `call_id` equal to the **canonical
(master) id** for *every* leg. For the confirmed pair, both
`GET /transcripts/4591131021746176` and `GET /transcripts/6643403700510720` returned
top-level `call_id = 6643403700510720`. The worker already fetches this response in
the fetch-transcript stage but discards the field.

The webhook receiver is **not deployed** (transcripts are pulled via API only), so the
fix is entirely reconciliation-/worker-side; no cross-path dedup is needed.

A separate latent hazard — `call_id > 2^53` losing precision through `JSON.parse` +
`String()` — did **not** cause this incident (the confirmed ids are below the
threshold and round-trip exactly) and is descoped to a follow-up (see below).

## Approach

Collapse legs at the **fetch-transcript stage** — the earliest point the canonical id
exists — dropping non-canonical legs before the expensive redact/classify/extract
stages run, so we remove the duplicate **and** stop the wasted model spend. (Chosen
over store-time rekey, which still pays for both model calls on every duplicate leg
and leaves duplicate raw/clean transcripts for retention to untangle.)

## Prevention (going forward)

### 1. Surface the canonical id from the transcript client

`DialpadClient.fetchTranscript` parses the response but throws away the top-level
`call_id` (`src/dialpad/client/client.ts`). Its `ready` result changes from
`{ kind: 'ready', transcript }` to `{ kind: 'ready', transcript, canonicalCallId }`,
where `canonicalCallId` is the response's top-level `call_id` normalized to a string,
or `undefined` when Dialpad omits it. The raw text stored is unchanged.

### 2. Collapse in the fetch-transcript stage

In the `ready` branch, before storing, compare `canonicalCallId` to the job's `callId`:

- **Equal, or canonical absent** → behave exactly as today (store transcript,
  continue). Fail-open: if Dialpad ever stops sending the field we degrade to current
  behavior, never to dropping calls.
- **Different** → this job is a non-canonical leg. Do **not** store its transcript.
  Run the safeguard (step 3), then return `drop` with reason `duplicate_call_leg` and
  a PII-free detail `{ canonical_call_id }`.

The dropped leg is skipped *before* redact/classify/extract — no model cost — and
never creates a `structured_knowledge` row.

### 3. Canonical-leg safeguard (never lose a call)

Before dropping a non-canonical leg, guarantee the canonical call runs, reusing
`seedCallStateIfAbsent` + `enqueueCall`:

- `seedCallStateIfAbsent(canonicalCallId)` — if it reports **created** (canonical not
  yet known), enqueue the canonical call. If it reports **already existed**
  (reconciliation listed it, or another leg seeded it), do nothing.

Exactly-once and idempotent even with both legs in flight (insert-if-absent is
atomic). Covers the case where reconciliation lists only a non-canonical leg and never
the canonical one. Termination: the canonical leg satisfies `canonical == callId`, so
it proceeds and never re-enqueues.

### 4. Data-model + state-machine changes

- Add `duplicate_call_leg` to `DROP_REASONS` (`src/db/enums.ts`) and a new migration
  extending the `call_state_drop_reason_value_chk` CHECK list (mirroring migration 6,
  `1782864000006_call_state_drop_reason.cjs`).
- Add `fetch-transcript` to the set of stages where a `skipped` row is valid
  (`SKIP_STAGES`, enforced in `src/pipeline/state-machine.ts:138`) so the
  drop-at-fetch-transcript passes the status/stage consistency guard.
- The new migration re-bumps the known migration-offset tests (routine in this repo).

## Cleanup of existing duplicates (one-off)

`structured_knowledge` has no soft-delete column (it is the durable asset), so retire
existing dupes via a nullable **`superseded_by_call_id text`** column (new migration).

Script `src/scripts/dedupe-call-legs.ts` (run inside Railway, like the prior
`reextract-recategorize` one-off):

1. Walk existing `structured_knowledge` rows, newest first, in bounded batches.
2. For each, call Dialpad `GET /transcripts/{callId}` and read the top-level canonical
   `call_id`. (Fetch from **Dialpad**, not our purged raw store, so it resolves any
   call Dialpad still retains — wider than our retention window.)
3. `canonical == callId` → real call, leave it. `canonical != callId` → duplicate leg;
   confirm the canonical row exists in `structured_knowledge`, then set
   `superseded_by_call_id = canonical` on the duplicate row.
4. **Dry-run by default** (reports counts + the id pairs it would act on); `--apply`
   performs the supersede. Anything unresolved (transcript gone at Dialpad, or
   canonical row missing) is **left untouched and reported**, never guessed.
5. Idempotent: a re-run re-supersedes nothing already superseded and produces no
   duplicate work.

The duplicate's `call_state` row is left untouched (still `completed`) as a historical
record; only the KB view hides it.

### KB read-model change

The four KB read queries share `buildWhere` in
`src/db/repositories/structured-knowledge-repo.ts` (search, count, export, aggregate).
Add one predicate — `superseded_by_call_id IS NULL` — so superseded rows vanish from
the HTML view, JSON, CSV, and summary counts consistently. Reversible: set the column
back to `NULL` to restore a row.

## Out of scope (follow-up)

- **`call_id` big-integer precision** (`> 2^53`). Correct fix is big-integer-safe JSON
  parsing of Dialpad response bodies — unrelated to leg-dedup and larger than a
  one-liner. File as a separate issue. Not triggering today (current ids round-trip
  exactly).

## Test plan

- **Unit** — client surfaces `canonicalCallId` (string / number / absent);
  fetch-transcript stage: canonical == leg → store + continue; canonical != leg →
  `drop('duplicate_call_leg')` + seed-if-absent/enqueue (created ⇒ enqueue, existed ⇒
  no enqueue); canonical absent → continue (fail-open).
- **Integration** — two legs of one call end with exactly one `structured_knowledge`
  row under the canonical id; the non-canonical leg is `skipped`, stored no raw
  transcript, and made zero model calls.
- **State machine** — a `skipped` row at `fetch-transcript` passes the consistency
  guard.
- **KB repo** — superseded rows are absent from search, count, export, and aggregate.
- **Cleanup script** — dry-run reports id pairs; `--apply` sets
  `superseded_by_call_id`; unresolved cases left untouched and reported; re-run is
  idempotent.
- **Migrations** — up/down for the new `drop_reason` and the `superseded_by_call_id`
  column; migration-offset test bumps.

## Privacy / conventions

- No transcript content or PII in logs, drop details, or the cleanup report — only
  ids and counts (`context` carries `call_id` only).
- Deletes stay soft/reversible (supersede column, not a hard delete).
- Idempotency preserved end-to-end (seed-if-absent, upsert-by-call_id, idempotent
  cleanup).
- Fail-safe: unknown/absent canonical id degrades to current behavior, never to
  dropping a call.
