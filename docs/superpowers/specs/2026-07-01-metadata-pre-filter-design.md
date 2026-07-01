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
`fetch-transcript`). The stage can only ever under-drop, never mis-drop a real
customer conversation.

## Outcomes

The stage produces exactly one of two outcomes:

- **pass** — leave the call ready for `fetch-transcript` (runner advances normally).
- **dropped/skipped** — stop the per-call pipeline before `fetch-transcript`, record a
  specific drop reason in `call_state`, and append a `processing_log` row. The
  `call_state` row and its original metadata are **never deleted** — a dropped call
  stays fully recoverable.

## Architecture — four independently testable pieces

### 1. Pure decision function — `src/pipeline/metadata-prefilter.ts`

```
evaluateMetadata(callId: string, metadata: unknown): PrefilterOutcome
type PrefilterOutcome = { action: 'pass' } | { action: 'drop'; reason: DropReason }
type DropReason =
  | 'zero_duration'
  | 'non_conversation_call_state'
  | 'outbound_no_customer_conversation'
  | 'internal_transfer_non_operator_leg'
```

- A **lenient** zod schema parses `source_metadata`. `safeParse` failure → **pass**
  (never throws, never drops on a parse error). Unknown fields are ignored
  (`.passthrough()`).
- Zero DB, zero I/O, zero transcript access, no model, no PII logging — so this
  function trivially satisfies every "metadata-only" constraint and is exhaustively
  unit-testable with plain fixtures.
- `callId` is passed explicitly (not read from metadata) so the operator-leg
  comparison is reliable.

**Drop rules — first match wins; anything else → pass:**

| reason | fires only when |
| --- | --- |
| `zero_duration` | `duration` is a number and `<= 0` |
| `non_conversation_call_state` | `state` ∈ allowlist that unambiguously means no two-party conversation: `missed`, `no_answer`, `voicemail`, `failed`, `busy`, `canceled`, `abandoned`, `rejected` (compared case-insensitively) |
| `internal_transfer_non_operator_leg` | `operator_call_id` present **and** `!== callId` (a known operator/customer leg that is not this one) |
| `outbound_no_customer_conversation` | `direction === 'outbound'` **and** an explicit internal-only indicator (`is_internal === true`) |

**Explicit pass cases (conservative):**

- `duration` absent or not a number → pass (don't assume zero).
- `state` unknown / not in the allowlist → pass.
- `operator_call_id` absent → pass. `master_call_id` present but `operator_call_id`
  absent → ambiguous graph → pass. `operator_call_id === callId` → this **is** the
  operator leg → pass.
- `direction` absent/unknown, or outbound without a clear internal indicator → pass.

### 2. Schema change — `migrations/1782864000006_call_state_drop_reason.cjs`

- **up:** add nullable `drop_reason text` to `call_state`.
- **down:** drop the column.
- Additive + reversible → no backup step required (non-destruction convention).
- Update `src/db/schemas/call-state.ts`: `callStateRowSchema` gains
  `drop_reason: z.string().nullable()`. `upsertCallState` does not set it (defaults
  `NULL`); its `ON CONFLICT DO UPDATE` does not touch `drop_reason`, so a re-seed of a
  dropped call preserves the reason.

`call_state` remains the durable spine (never purged); `drop_reason` is `NULL` for
every call except dropped ones.

### 3. DAL helper — `skipCall` in `src/db/repositories/call-state-repo.ts`

```
skipCall(pool, { callId, atStage, dropReason, logDetail? }): Promise<CallStateRow>
```

- One transaction via `withTransaction` + `appendLog` (the same atomic pattern as
  `advanceStage`), so `call_state` and the audit trail can never diverge:
  1. `UPDATE call_state SET status='skipped', drop_reason=$reason, updated_at=now()
     WHERE call_id=$ AND current_stage=$atStage` — the `current_stage` guard is the
     same optimistic concurrency check `advanceStage` uses; no row matched →
     `DAL_STALE_STAGE`.
  2. `appendLog` a `processing_log` row `{ stage:'metadata-pre-filter',
     outcome:'skipped', detail:{ drop_reason } }`.
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
  type StageResult = { action: 'continue' } | { action: 'drop'; reason: string; detail?: JsonValue }
  ```
  `void`/`undefined` is treated as continue, so the existing stub handlers and the
  test override handlers keep working unchanged.
- Add `STATUS_SKIPPED = 'skipped'` alongside `STATUS_PROCESSING` / `STATUS_COMPLETED`.
- `StageContext` gains `pool: Pool` (every real stage will need DB access; the runner
  already holds the pool). The pre-filter handler reads `source_metadata` via
  `getCallState`, calls `evaluateMetadata(callId, source_metadata)`, and returns the
  outcome.
- Runner (`runPipeline`):
  - After a handler returns `{ action: 'drop', reason }`, call
    `skipCall(pool, { callId, atStage: stage, dropReason: reason, ... })` and
    **return** — the loop never reaches `fetch-transcript`.
  - Add a terminal no-op guard: `status === STATUS_SKIPPED` → log + return (mirrors the
    `completed` guard), so a re-enqueued dropped call never re-runs stages or
    duplicates `processing_log` rows.

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
- Concurrent runner already moved the call: `skipCall`'s `current_stage` guard yields
  `DAL_STALE_STAGE`, handled by the runner's existing stale-stage resolution path.
- Re-enqueue of a dropped call: terminal `skipped` no-op guard → no duplicate work or
  log rows.
- `skipCall` and the whole stage never touch `raw_transcripts`, the token vault, or any
  transcript client.

## Testing

**Unit — no DB** (`test/pipeline/metadata-prefilter.test.ts`), pure `evaluateMetadata`:

- zero-duration call → `drop zero_duration`.
- clear outbound internal-only leg → `drop outbound_no_customer_conversation`.
- transfer graph where only the true operator/customer leg passes; a non-operator leg
  → `drop internal_transfer_non_operator_leg`.
- ambiguous outbound call (no internal indicator) → `pass`.
- incomplete/contradictory transfer graph (e.g. `master_call_id` but no
  `operator_call_id`) → `pass`.
- non-conversation call state → `drop non_conversation_call_state`; unknown state →
  `pass`.
- Pure function ⇒ no test path reads `raw_transcripts` or invokes any transcript
  client.

**DB-backed short-circuit** (`test/pipeline/metadata-prefilter-shortcircuit.test.ts`,
`describe.skipIf(!hasTestDb)`), via `runPipeline` with a **spy** `fetch-transcript`
handler:

- dropped call: assert `status='skipped'`, `drop_reason` set, `current_stage` still
  `metadata-pre-filter`, a `processing_log` `skipped` row exists, the `call_state` row
  is still present (not deleted), and the `fetch-transcript` spy was **never called** —
  proves the pipeline short-circuits before the transcript stage.
- passing call: the `fetch-transcript` spy **is** called (the call advances past the
  filter).
- idempotency: re-running a skipped call adds no new `processing_log` row.

## Documentation

- CLAUDE.md §2: `call_state` contents note gains `drop_reason`.
- CLAUDE.md §3: metadata-pre-filter bullet lists the drop reasons and notes
  `status='skipped'` / `drop_reason` on a drop.
- CLAUDE.md "current repo state" note: add the metadata pre-filter (Task 3.1).
- No new config, no `.env.example` change, no ADR (not in the §5 ADR list).

## Provisional (fails safe regardless)

The exact Dialpad field names (`duration`, `state`, `direction`, `operator_call_id`,
`master_call_id`, `is_internal`) are confirmed against the real webhook payload in Task
3.2. Because the stage passes on anything it does not clearly recognize, a wrong field
mapping can only cause under-dropping (safe), never a mis-drop of a real call. The
lenient schema and the drop-rule allowlists are the single place those names are
adjusted when 3.2 lands.
```

