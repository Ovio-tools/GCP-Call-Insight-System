# ADR 0004 — Held-call retention policy and per-reason review SLA

Status: accepted (Task 6.1, 2026-07-03)

## Context

Every pipeline hold path already funnels through one seam — a stage returns
`{action:'hold', reason}`, the runner calls `holdCall`, which atomically sets
`call_state.status='held'`, writes one active `review_queue` row, and appends a
`processing_log` row. The **plumbing existed; the policy did not**: the SLA was a
hardcoded `now() + 24h`, nothing wrote `review_queue.escalated_at`/`raw_purged_at`,
the "exactly one active row per call" invariant was only procedural, and there was
no cap on how long an unresolved held call's raw PII could be retained. Task 6.1
defines that policy and leaves the purge hooks for Task 8.1 (deletion never runs in
the per-call path).

## Decisions

### 1. Per-`held_reason` SLA from a single validated env map

`REVIEW_SLA_MINUTES_BY_REASON` is one JSON-object env var validated by a zod schema
that (a) parses JSON inside a transform so malformed JSON becomes a named
`CONFIG_MISSING_OR_INVALID`, not an uncaught `SyntaxError`; (b) requires every
`HELD_REASON` member as a key (fail-closed — the enum is the completeness oracle);
(c) requires `emergency_review` to be the **strict minimum**; and (d) floors every
value at the reconciliation-cron scan cadence (`REVIEW_SLA_SCAN_CADENCE_MINUTES = 15`),
so no SLA is shorter than the interval at which breaches are detected. It is
**required with no default** — the pipeline must not run without an explicit SLA
policy. `slaMinutesFor(config, reason)` is a pure lookup (totality guaranteed at
boot). `holdCall` computes `sla_due_at = now() + slaMinutes` off the transaction
clock (so `sla_due_at = created_at + slaMinutes` exactly). **Max SLA-breach
detection latency is one scan cadence** (~15 min).

`classified_spam` (Task 5.1 enum drift) gets a real SLA like every other reason;
`weak_servicetitan_match` gets an SLA entry for map totality but has no producing
stage yet (ServiceTitan is Task 12.1 — no fake producer is wired).

### 2. Active-row invariants are now DB guarantees (migration 012)

A partial unique index `review_queue_one_active_per_call (call_id) WHERE status IN
('open','in_review')` makes "exactly one active review per call" a DB guarantee; the
`holdCall`/`enqueueReview` writers target it by index inference (`ON CONFLICT
(call_id) WHERE ... DO NOTHING`), never a named constraint. A CHECK
`review_queue_active_has_sla` guarantees every active row carries an SLA, so the
stalled-review scan (`sla_due_at < now`) can never silently miss a NULL-SLA row. Two
loud `up` preflights refuse to migrate — without auto-deleting — if pre-existing data
violates either invariant. A conflicting-reason re-hold is treated as corruption
(`DAL_REVIEW_INVARIANT`, rolled back), not a silently-logged discrepancy.

### 3. SLA-breach escalation folded into the reconciliation cron (no fifth service)

`scanStalledReviews` drains the whole due set in bounded batches; each item is
escalated + alerted in its own transaction (`recordAlert` enlisted in the same tx as
the `escalated_at` stamp), so a failed alert insert rolls back and leaves the item
eligible next run — no lost alert, no silent escalation. The dedup key is scoped to
the review **item** (`REVIEW_QUEUE_STALLED:review_queue:<id>`), so a re-held call gets
its own alert. The scan is folded into the existing reconciliation cron (every 15 min,
UTC): the entrypoint runs the sweep and the scan as **two independent duties** — the
scan runs even if the sweep failed — and fires the (moved-out) external ping only when
**both** succeed; a non-zero `failed` **or** `lockedSkipped` withholds it, so a broken
scan surfaces via the missed check. `REVIEW_SLA_SCAN_CADENCE_MINUTES` must track the
Railway cron schedule (documented drift guard).

### 4. Held-raw retention cap + clean-transcript survival (the 6.1 ↔ 8.1 seam)

`REVIEW_HELD_RAW_RETENTION_CAP_HOURS` (required, no default) bounds how long an
unresolved held call's raw transcript + vault may be retained. The cap is a **maximum
raw-PII retention limit**, so on the cap the raw/vault are **hard-purged** (rendered
unrecoverable) — a soft delete does not satisfy it. Task 8.1 owns the deletion; Task
6.1 provides the hooks:

- `listRawPurgeEligible(pool, capHours, now)` selects `open`/`in_review`/**`unresolvable`**
  items past the cap with `raw_purged_at IS NULL` (an unresolvable item's raw is purged
  on the cap "regardless").
- `hasBlockingReviewForRawPurge` / `hasBlockingReviewForCleanTranscript` are the
  invariants Task 8.1's **normal** purge predicates must honour: the normal raw/vault
  purge excludes calls with an active/unresolvable review whose raw is un-purged; the
  normal clean-transcript purge excludes calls with an `open`/`in_review`/`unresolvable`
  review, so **redacted text survives even after raw/vault are cap-purged** and the
  review stays resolvable/auditable. The clean-transcript predicate does NOT clear when
  raw is purged (the clean transcript must outlive the raw).
- `markRawPurged(client, id, now)` stamps `review_queue.raw_purged_at` inside Task 8.1's
  hard-removal transaction — the seam between the two tasks. `review_queue` is not
  purgeable, so the row itself survives.

### 5. `unresolvable` moves `call_state` too — new terminal `review_closed`

Marking a review `unresolvable` must also move `call_state` off `held`, or the runner's
held-terminal guard treats it as corruption. `markUnresolvable(pool, callId, actor)` does
both in one transaction — review → `unresolvable` (+`resolved_at`), `call_state` `held` →
new terminal `review_closed`, and a `mark_unresolvable` audit row — with exact-count guards
(exactly one active review, exactly one `held` call_state) that roll back and throw on any
miss. The call-state status vocabulary (`CALL_STATE_STATUSES`,
`UPSERT_PROTECTED_CALL_STATE_STATUSES`) lives in the DB layer (`src/db/enums.ts`), which both
the pipeline and DAL import, so the upsert can protect terminal states without a db → pipeline
dependency. `upsertCallState` now preserves `held` and `review_closed` too (fixing a latent bug
where a duplicate webhook could resurrect a live held call), and the runner has a strict
`review_closed` terminal guard requiring a matching `unresolvable` review.

## Consequences

- A held call is never purged of raw PII before its cap, and never keeps raw PII past it.
- Redacted text and the review row outlive a cap purge, so review stays possible.
- No new service, no new `*_CHECK_URL`, no inline deletion. Deletion remains Task 8.1's
  scheduled, grace-windowed, dry-runnable job.
- A finite _archival_ window for terminal `unresolvable` clean text is left as a follow-up
  (redacted text is medium-sensitivity, not raw PII).
