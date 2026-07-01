# Task 3.1 — Metadata pre-filter — design

_Date: 2026-07-01 · Branch: `task/3.1-metadata-pre-filter` · Build plan §3_

## Purpose

Add the first per-call pipeline stage: a **deterministic, metadata-only** filter that
runs before `fetch-transcript` and drops obvious junk calls before any transcript is
pulled. It must never read `raw_transcripts`, call the Dialpad transcript client,
inspect transcript text, call a model, or log PII. It uses only call metadata already
present on `call_state` (`source_metadata`) — direction, duration, call state,
timestamps, and the related-call graph (`operator_call_id`, `master_call_id`).

**Fail safe:** when a needed field is missing, unknown, contradictory, or the
provider semantics are unclear, the call **passes** (is left ready for
`fetch-transcript`). Every drop rule keys on an **explicit positive marker**, so a
wrong or unconfirmed field mapping can only ever cause under-dropping (safe), never a
mis-drop of a real customer conversation.

## Outcomes

The stage produces exactly one of two outcomes:

- **pass** — leave the call ready for `fetch-transcript` (runner advances normally).
- **dropped/skipped** — stop the per-call pipeline before `fetch-transcript`, record a
  specific drop reason in `call_state`, and append a `processing_log` row. The
  `call_state` row and its original metadata are **never deleted** — a dropped call
  stays fully recoverable.

## Controlled drop vocabulary (enforced, not free text)

`DropReason` is a shared source of truth used in three places kept in lockstep:

- a zod enum `dropReasonSchema` / `DROP_REASONS` tuple in `src/db/enums.ts`
  (next to `HELD_REASON`, so the DAL layer can reference it without importing up into
  the pipeline layer),
- the `StageResult` drop type and `skipCall`'s input (`reason: DropReason`, **not**
  `string`, validated by `dropReasonSchema`),
- DB `CHECK` constraints on `call_state` — a value list **and** a `status ⇔
  drop_reason` biconditional (see §2).

```
DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
] as const
```

Adding a future reason means editing the tuple **and** the CHECK constraint (a
migration) — the vocabulary cannot drift into arbitrary strings.

## Architecture — four independently testable pieces

### 1. Pure decision function — `src/pipeline/metadata-prefilter.ts`

```
evaluateMetadata(callId: string, metadata: unknown): PrefilterOutcome
type PrefilterOutcome = { action: 'pass' } | { action: 'drop'; reason: DropReason }
```

- A **lenient** zod schema parses `source_metadata`. `safeParse` failure → **pass**
  (never throws, never drops on a parse error). Unknown fields are ignored
  (`.passthrough()`).
- Zero DB, zero I/O, zero transcript access, no model, no PII logging — so this
  function trivially satisfies every "metadata-only" constraint and is exhaustively
  unit-testable with plain fixtures.
- `callId` is passed explicitly (not read from metadata) so the operator-leg
  comparison is reliable.

**Drop rules — first match wins; anything else → pass. Every rule requires an explicit
positive marker:**

| reason | fires only when |
| --- | --- |
| `zero_duration` | `duration` is a number and `<= 0` |
| `non_conversation_call_state` | `state` ∈ allowlist that unambiguously means no two-party conversation: `missed`, `no_answer`, `failed`, `busy`, `canceled`, `abandoned`, `rejected` (case-insensitive). **`voicemail` is deliberately excluded** — a voicemail can carry customer intent; it fails open to `fetch-transcript` (see Open questions). |
| `internal_transfer_non_operator_leg` | `is_internal === true` **and** `operator_call_id` present **and** `operator_call_id !== callId` — an explicitly-flagged internal leg that the graph also shows is not the operator/customer leg |
| `outbound_no_customer_conversation` | `is_internal === true` **and** `direction === 'outbound'` (and not already caught by the transfer rule) |

`is_internal` is the core "no customer on this leg" signal; direction / graph context
refine it into the specific reason. Because both graph-derived rules require
`is_internal === true`, absence of that explicit marker (the common and the
unconfirmed-semantics case) → **pass**.

**Explicit pass cases (conservative / fail open):**

- `duration` absent or not a number → pass (don't assume zero).
- `state` unknown / not in the allowlist (including `voicemail`) → pass.
- `is_internal` absent or not `true` → pass, regardless of `operator_call_id` /
  `master_call_id` / `direction`. Id inequality **alone** never drops.
- `operator_call_id === callId` → this **is** the operator leg → pass.
- `master_call_id` present but `operator_call_id` absent → ambiguous graph → pass.
- `direction` absent/unknown → pass.

### 2. Schema change — `migrations/1782864000006_call_state_drop_reason.cjs`

- **up:** add nullable `drop_reason text` to `call_state`, plus two `CHECK`
  constraints:
  - **value:** `drop_reason IS NULL OR drop_reason IN (<DROP_REASONS>)`.
  - **relationship (biconditional):** `(status = 'skipped') = (drop_reason IS NOT
    NULL)` — a `skipped` row must carry a reason, and any non-null reason requires
    `status = 'skipped'`. This makes the doc's "reason is null for every call except
    dropped ones" a DB-enforced invariant, not just a convention, and rejects
    contradictory rows (`processing` + reason, or `skipped` + null).
- **down:** drop both constraints and the column.
- Additive + reversible → no backup step required (non-destruction convention).
- Update `src/db/schemas/call-state.ts`: `callStateRowSchema` gains
  `drop_reason: z.string().nullable()`.
- The DROP_REASONS list in the migration and the `DROP_REASONS` tuple in `stages.ts`
  are kept in sync by hand (documented at both sites), mirroring the existing
  enum-duplication convention in `src/db/enums.ts`.

`call_state` remains the durable spine (never purged); `drop_reason` is `NULL` for
every call except dropped ones.

### 2a. Terminal-state protection on ingest upsert — `upsertCallState`

`upsertCallState` currently overwrites `status` and `current_stage` from `EXCLUDED` on
conflict. A webhook/reconciliation **re-seed** of an already-terminal call would
resurrect it (`skipped`/`completed` → `processing`), defeating the skipped terminal
guard and re-running the pre-filter. Fix the `ON CONFLICT DO UPDATE` to **preserve
terminal state**:

```
source        = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source ELSE EXCLUDED.source END
source_metadata = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source_metadata ELSE EXCLUDED.source_metadata END
current_stage = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.current_stage ELSE EXCLUDED.current_stage END
status        = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.status ELSE EXCLUDED.status END
-- drop_reason is never overwritten by upsert (only skipCall sets it)
updated_at    = now()
```

A terminal row is thus frozen whole — `source`, `source_metadata`, `current_stage`,
`status`, and `drop_reason` all retain their original values — so the promise that a
dropped call's original metadata is never rewritten holds for every column.

A non-terminal row upserts exactly as before. A future explicit **reprocess** path
(Task 6.2) will reset terminal state through its own dedicated function, never through
`upsertCallState`. This also hardens `completed` against re-seed resurrection (a
latent bug today), which the skipped terminal guarantee depends on.

### 3. DAL helper — `skipCall` in `src/db/repositories/call-state-repo.ts`

```
skipCall(pool, { callId, atStage, dropReason, logDetail? }): Promise<CallStateRow>
```

- One transaction via `withTransaction` + `appendLog` (the same atomic pattern as
  `advanceStage`), so `call_state` and the audit trail can never diverge:
  1. `UPDATE call_state SET status='skipped', drop_reason=$reason, updated_at=now()
     WHERE call_id=$ AND current_stage=$atStage AND status='processing'`. The
     `status='processing'` term makes the update **idempotent under concurrency**:
     once the row is `skipped`, a second runner matches **zero** rows →
     `DAL_STALE_STAGE`, so no duplicate `skipped` log row is appended.
  2. `appendLog` a `processing_log` row `{ stage:'metadata-pre-filter',
     outcome:'skipped', detail:{ drop_reason } }`.
- The input `dropReason` is validated by `dropReasonSchema` (the shared zod enum) in
  the helper's parse step, so the DAL rejects an out-of-vocabulary reason before the
  DB CHECK is ever reached — two independent guards against drift.
- `current_stage` stays where it is (no forward movement). The row is **never
  deleted**.
- A drop is **not** a failure-model failure: no `error_code`, no `failure_snapshot`.
  The reason is a controlled pipeline vocabulary, not a taxonomy code.

A dedicated helper (rather than overloading `advanceStage`) keeps the semantics
honest — "advance" that does not advance would be misleading — while reusing the same
transaction + log-append machinery.

### 4. State-machine short-circuit — `src/pipeline/stages.ts` + `state-machine.ts`

- `StageHandler` return type becomes `Promise<StageResult | void>`:
  ```
  type StageResult = { action: 'continue' } | { action: 'drop'; reason: DropReason; detail?: JsonValue }
  ```
  `void`/`undefined` is treated as continue, so the existing stub handlers and the
  test override handlers keep working unchanged.
- Add `STATUS_SKIPPED = 'skipped'` alongside `STATUS_PROCESSING` / `STATUS_COMPLETED`.
- `StageContext` gains `pool: Pool` (every real stage will need DB access; the runner
  already holds the pool). The pre-filter handler reads `source_metadata` via
  `getCallState`, calls `evaluateMetadata(callId, source_metadata)`, and returns the
  outcome.
- Runner (`runPipeline`):
  - **Terminal no-op guard** at the top: `status === STATUS_SKIPPED` → **validate then**
    log + return (mirrors the `completed` guard, which treats terminal + wrong stage as
    corruption). A valid `skipped` row must have `current_stage` ∈ the skip-stage set
    (`{ 'metadata-pre-filter' }` today — the only stage that drops) **and** a non-null
    `drop_reason`; otherwise throw an inconsistency error rather than silently
    returning. The skip-stage set generalizes when a future stage gains drop capability.
  - **Drop branch:** after a handler returns `{ action: 'drop', reason }`, call
    `skipCall(pool, { callId, atStage: stage, dropReason: reason, ... })` and
    **return** — the loop never reaches `fetch-transcript`. If `skipCall` throws
    `DAL_STALE_STAGE` (a concurrent runner won the race), re-read the row: if it is now
    `skipped` (or `completed`) → treat as terminal and return (no-op); otherwise throw
    an inconsistency error. This is a small drop-specific check — it does **not** reuse
    `resolveStale`, which is tailored to forward advancement and would wrongly throw on
    a `skipped` status.

**Wiring:** the real handler replaces the stub for `metadata-pre-filter` in
`defaultStageHandlers`. The worker consumes `defaultStageHandlers` unchanged, so no
`worker.ts` edit is needed. The runner is the single choke point: a dropped call
physically cannot reach the transcript stage, so the transcript client (built later in
3.2/4.x) is only ever reachable for calls whose pre-filter outcome is **pass**.

## Data flow

```
job -> runPipeline -> [metadata-pre-filter handler]
  reads call_state.source_metadata (no transcript, no model)
  -> evaluateMetadata(callId, metadata)
     -> pass  -> advanceStage(metadata-pre-filter -> fetch-transcript)  -> continue
     -> drop  -> skipCall(status='skipped', drop_reason=<reason>,
                          processing_log{outcome:'skipped'})  -> STOP (return)
```

## Error handling / edge cases

- Parse failure of `source_metadata` → pass (fail safe).
- Concurrent runners both reach the drop: first `skipCall` wins; the second matches
  zero rows (`status='processing'` guard) → `DAL_STALE_STAGE` → runner re-reads,
  sees `skipped`, returns. Exactly one `skipped` log row.
- Re-enqueue / re-run of a dropped call: terminal `skipped` no-op guard → no duplicate
  work or log rows.
- Re-seed (ingest upsert) of a terminal call: preserved by the `CASE` guard in
  `upsertCallState` → never resurrected to `processing`.
- `skipCall` and the whole stage never touch `raw_transcripts`, the token vault, or any
  transcript client.

## Testing

**Unit — no DB** (`test/pipeline/metadata-prefilter.test.ts`), pure `evaluateMetadata`:

- zero-duration call → `drop zero_duration`.
- clear outbound internal-only leg (`is_internal:true, direction:'outbound'`) →
  `drop outbound_no_customer_conversation`.
- transfer graph where only the true operator/customer leg passes; a non-operator leg
  (`is_internal:true`, `operator_call_id` ≠ this id) →
  `drop internal_transfer_non_operator_leg`.
- **id inequality alone, no `is_internal`** → `pass` (guards against the
  over-confident-graph regression).
- ambiguous outbound call (no `is_internal`) → `pass`.
- incomplete/contradictory transfer graph (`master_call_id` but no `operator_call_id`)
  → `pass`.
- non-conversation call state → `drop non_conversation_call_state`; unknown state and
  `voicemail` → `pass`.
- Pure function ⇒ no test path reads `raw_transcripts` or invokes any transcript
  client.

**DB-backed** (`test/pipeline/metadata-prefilter-shortcircuit.test.ts`,
`describe.skipIf(!hasTestDb)`), via `runPipeline` with a **spy** `fetch-transcript`
handler:

- dropped call: assert `status='skipped'`, `drop_reason` set, `current_stage` still
  `metadata-pre-filter`, a `processing_log` `skipped` row exists, the `call_state` row
  is still present (not deleted), and the `fetch-transcript` spy was **never called** —
  proves the pipeline short-circuits before the transcript stage.
- passing call: the `fetch-transcript` spy **is** called (the call advances past the
  filter).
- idempotency: re-running a skipped call adds no new `processing_log` row.
- **double/concurrent skip:** calling `skipCall` (or `runPipeline`) twice on the same
  call yields exactly one `skipped` `processing_log` row.
- **re-seed resurrection:** upserting a skipped call again leaves it `skipped` with
  `drop_reason` and `current_stage` intact (also covers `completed`).
- **drop-reason TS/DB parity:** for **every** value in `DROP_REASONS`, `skipCall`
  stores it successfully (iterate the tuple) — proves the DB CHECK value list is a
  superset of the TS vocabulary.
- **invalid reason rejected at both layers:** an out-of-vocabulary reason is rejected
  by the zod/DAL parse in `skipCall`; a raw SQL `UPDATE ... SET drop_reason='bogus'`
  (bypassing the DAL) is rejected by the DB CHECK constraint.
- **status/drop_reason invariant:** a raw SQL update setting `status='skipped',
  drop_reason=NULL` (and the inverse, `status='processing'` with a non-null reason) is
  rejected by the biconditional CHECK.
- **corrupt terminal row:** `runPipeline` on a `skipped` row whose `current_stage` is
  not a skip-stage (or whose `drop_reason` is null) throws an inconsistency error
  rather than no-oping.

## Documentation

- CLAUDE.md §2: `call_state` contents note gains `drop_reason`.
- CLAUDE.md §3: metadata-pre-filter bullet lists the drop reasons and notes
  `status='skipped'` / `drop_reason` on a drop.
- CLAUDE.md "current repo state" note: add the metadata pre-filter (Task 3.1).
- No new config, no `.env.example` change, no ADR (not in the §5 ADR list).

## Open questions

- **`voicemail`:** excluded from the hard-drop allowlist so voicemail-derived intent is
  not silently dropped. Confirm with Eric that voicemail should flow into the pipeline
  (fetch/availability handles the no-transcript case). If he explicitly wants no
  voicemail insights, add `voicemail` to the allowlist.

## Provisional (fails safe regardless)

The exact Dialpad field names (`duration`, `state`, `direction`, `operator_call_id`,
`master_call_id`, `is_internal`) are confirmed against the real webhook payload in Task
3.2. Because **every** drop rule requires an explicit positive marker and the stage
passes on anything it does not clearly recognize, a wrong field mapping can only cause
under-dropping (safe), never a mis-drop of a real call. The lenient schema and the
drop-rule allowlists are the single place those names are adjusted when 3.2 lands.
```

