# Typed Data-Access Layer (DAL) over the schema — Task 1.2

## Context

Task 1.1 landed the full Postgres schema (18 tables, native enums, three group
roles, envelope encryption). Nothing in the app reads or writes those tables yet —
`src/db/` does not exist. Every future pipeline stage and surface needs a typed,
validated way to touch the data, and the privacy/idempotency conventions in
CLAUDE.md (§2, §3, §5) must be enforced at the data layer, not re-invented per
caller. This task builds that layer: zod-validated accessors for **every** table,
idempotent per-call writes, an atomic stage-advance, DB-role-isolated + encrypted
access to the two restricted tables, and the specific write helpers the pipeline and
review surface need — plus integration tests proving the load-bearing behaviors.

The layer follows established scaffold conventions: ESM with `.js` import extensions,
strict TS, `pg` for IO, `zod` at boundaries, pino logger with the fail-loud redaction
guard, dependency-injected `pool`/`logger`/`keyProvider`, and a thin error forerunner
in the spirit of `src/boot/codes.ts` (do NOT build a parallel failure model — that is
Task 2.2).

This plan incorporates review feedback (see "Review fixes applied" below).

### Confirmed decisions

- **Restricted-role enforcement:** `SET LOCAL ROLE restricted_role` inside a
  transaction on the shared pool, and **all ordinary connections default to
  `app_role`** (a `connect`-handler `SET ROLE app_role` in `pool.ts`). Postgres checks
  `SET ROLE` membership against the **session/login user**, not the active role, so a
  connection sitting at `app_role` can still switch to `restricted_role` for a
  transaction — provided the login user is a (NOINHERIT) member of both group roles.
  This makes the privacy boundary DB-enforced (app queries genuinely run as `app_role`
  and get `42501` on the vault), not merely code-enforced. Matches the existing
  `SET ROLE` pattern in [role-isolation.test.ts](test/db/role-isolation.test.ts).
- **`match_keys` idempotency:** soft-delete-then-insert keyed on `call_id` inside the
  restricted transaction (no schema change, no new grant — see P1 fix below).
- **`match_keys` are HMAC digests, not ciphertext** (CLAUDE.md §2). They do NOT round-
  trip through the envelope-encryption helper; the DAL stores/reads the HMAC `bytea`
  produced upstream. `key_version` records which HMAC key/salt version was used. This
  deviates from the original task wording ("both pass through the envelope-encryption
  helper"); the schema and the review are authoritative. Only `token_vault` (and the
  app-role `raw_transcripts`) use `encrypt`/`decrypt`.

### Review fixes applied

- **P1 — no DELETE privilege.** `restricted_role` and `app_role` both lack DELETE
  (only `purge_role` has it — [grants L60/L54](migrations/1782864000005_grants.cjs)).
  Set-replacement for `redaction_findings` (app_role) and `match_keys` (restricted_role)
  therefore uses **soft-delete-then-insert**: `UPDATE ... SET soft_deleted_at=now()
  WHERE call_id=$1 AND soft_deleted_at IS NULL`, then bulk `INSERT`. Uses only granted
  privileges, matches "deletes are soft first; hard purge only in the retention cron."
- **P1 — connections bound to `app_role`.** `pool.ts` issues `SET ROLE app_role` on
  every new connection (see decisions above); restricted ops temporarily
  `SET LOCAL ROLE restricted_role`.
- **P1 — all 18 tables covered.** Schemas + minimal repos for every table (below).
- **P2 — `enqueueReview` idempotent** per open/in-review call (below).
- **P2 — `match_keys` not decryptable** (see decision above); tests assert HMAC bytes
  round-trip byte-for-byte, never decryption.
- **P2 — automated restricted-import guard test** replaces the manual grep.

## Module layout (`src/db/`)

Kebab-case, ESM, `.js` imports, strict TS. Inject `pool` / `logger` / `keyProvider`.

```
src/db/
  pool.ts                 # createAppPool(connectionString): SET ROLE app_role on connect (prod + DAL calls)
                          # createOwnerPool(connectionString): no role switch (admin/test setup + cleanup)
  sql.ts                  # withTransaction(pool, fn), one()/many() row helpers
  enums.ts                # pg enum arrays (as const) + z.enum — single source of truth
  errors.ts               # DalError forerunner
  schemas/                # pure zod (no pg): RowSchema + InsertInputSchema per table (all 18)
  repositories/           # app_role IO
    call-state-repo.ts        # getCallState, upsertCallState, advanceStage
    raw-webhook-events-repo.ts# insertWebhookEvent, getWebhookEvent
    raw-transcripts-repo.ts   # putTranscript/getTranscript (envelope-encrypted, app_role table)
    clean-transcripts-repo.ts # upsert, get
    redaction-findings-repo.ts# replaceFindings (soft-delete-then-insert), getFindings
    structured-knowledge-repo.ts # upsert, get
    review-queue-repo.ts      # enqueueReview (idempotent), getReview, listOpen, setStatus
    operator-actions-repo.ts  # recordOperatorAction (before/after), listByReview
    model-invocations-repo.ts # recordModelInvocation, listByCall
    daily-cost-usage-repo.ts  # upsertDailyCost (accumulate on day), getDay
    alert-events-repo.ts      # recordAlert (dedup), acknowledgeAlert, listActive
    backfill-runs-repo.ts     # startRun, updateCheckpoint, getRun
    consent-gates-repo.ts     # recordConsent, listByType
    key-versions-repo.ts      # getKeyVersion, listKeyVersions, insertKeyVersion (metadata)
    processing-log-repo.ts    # appendLog (also used by advanceStage), listByCall
    dead-letter-repo.ts       # recordDeadLetter, listUncleared
    index.ts
  restricted/             # ONLY modules that may name token_vault / match_keys
    restricted-context.ts # RestrictedRunner: SET LOCAL ROLE restricted_role in a tx
    token-vault-repo.ts   # putToken/getToken — envelope encrypt/decrypt inside
    match-keys-repo.ts    # putMatchKeys/getMatchKeys — HMAC bytea, soft-delete-then-insert
    index.ts
  index.ts                # public barrel
```

Auditability: exactly two files under `restricted/` may reference the restricted table
names, routed through the single `restricted-context.ts` choke point. Enforced by an
automated guard test (below), not a manual grep.

## Reuse (do not re-implement)

- `encrypt`/`decrypt` from [src/crypto/envelope.ts](src/crypto/envelope.ts); pass
  `aad = Buffer.from(callId, 'utf8')` on both sides (pattern in
  `encrypted-row-roundtrip.test.ts`). `KeyProvider` / `keyProviderFromConfig` from
  `src/crypto/key-provider.ts`. Used by `token_vault` and `raw_transcripts` only.
- Enum value sets: [migrations/1782864000001_extensions_and_enums.cjs](migrations/1782864000001_extensions_and_enums.cjs).
- Error-forerunner pattern: [src/boot/codes.ts](src/boot/codes.ts) (sanitized context,
  never credentials/PII).
- Logging: `createCallLogger` from `src/logging/logger.ts`; forbidden-field guard in
  [src/logging/redaction.ts](src/logging/redaction.ts). **`token`, `name`, `phone`,
  `secret`, `dek`, `kek` are forbidden log keys** — vault/match-key code must never log
  those literals (use `token_ref`/counts).
- Test harness: `makePool()`, `migrate()`, `hasTestDb` from
  [test/db/_pg.ts](test/db/_pg.ts).

## Idempotency

Parameterized queries only (`$1..$n`), never string interpolation.

| Table | Strategy |
| --- | --- |
| `call_state` | `INSERT ... ON CONFLICT (call_id) DO UPDATE`, touch `updated_at=now()` |
| `clean_transcripts` | `ON CONFLICT (call_id) DO UPDATE` |
| `structured_knowledge` | `ON CONFLICT (call_id) DO UPDATE` |
| `raw_transcripts` | `ON CONFLICT (call_id) DO UPDATE` (re-encrypt refreshes ciphertext + key_version) |
| `token_vault` | `ON CONFLICT (call_id, token) DO UPDATE` (composite PK) |
| `daily_cost_usage` | `ON CONFLICT (day) DO UPDATE` (accumulate token/cost totals) |
| `alert_events` | `ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL DO NOTHING` (matches the partial unique index) |
| `redaction_findings` | **soft-delete-then-insert** keyed on `call_id`, one tx (app_role: UPDATE + INSERT) |
| `match_keys` | **soft-delete-then-insert** keyed on `call_id`, inside the restricted tx; per-call `pg_advisory_xact_lock(hashtext(call_id))` since restricted_role can't lock `call_state` |
| `review_queue` | `enqueueReview` idempotent per call: in a tx, `SELECT ... FROM call_state WHERE call_id=$1 FOR UPDATE` to serialize, then insert only if no `open`/`in_review` row for the call exists; otherwise return the existing row |

Append-only audit tables (`model_invocations`, `operator_actions`, `processing_log`,
`raw_webhook_events`, `consent_gates`, `dead_letter`) are intentionally **not** upserts
— idempotency there is the caller's queue-job key. Document this so a reviewer doesn't
expect `ON CONFLICT`.

**Soft-delete reads.** Because `redaction_findings` / `match_keys` set-replacement (and
all purgeable tables generally) intentionally leave soft-deleted history rows, **every
read over a purgeable table filters `soft_deleted_at IS NULL AND hard_deleted_at IS
NULL`** so callers never see stale findings/HMACs/transcripts. Applies to
`getFindings`, `getMatchKeys`, `getToken`, `getTranscript`, and the `clean_transcripts`
/ `raw_webhook_events` reads. Retention bookkeeping (`retention_eligible_at`) is set by
the store/mark-eligible stage; the retention cron does the hard purge.

## zod validation

Per table, two schemas in `src/db/schemas/<table>.ts`: **RowSchema** (read-back shape,
validated on every read) and **InsertInputSchema** (write input, omitting
DB-defaulted/retention columns, validated at the top of every write).

- Enums: `enums.ts` mirrors the pg native enum arrays as `as const` → `z.enum(...)`,
  with a runtime parity test asserting they match `enum_range(...)`.
- `bytea` (ciphertext, value_hash, phone_hmac, name_hmac) → `z.instanceof(Buffer)`.
- `jsonb` → permissive `jsonValueSchema`, tightened per column where known
  (e.g. `redaction_reasons` as `z.array(z.string())`).
- `numeric(5,4)` (`redaction_risk_score`) → string on read (node-pg returns numeric as
  string, avoids float loss); accept `number` on write, range `[0,1)`, pass as string.
- `integer` → `z.number().int()`; `bigint` (daily_cost_usage) → string; `timestamptz`
  → `z.date()`.
- A zod failure throws `DalError('DAL_VALIDATION_FAILED')` with context = table +
  column names only (never values — may be PII).

## Key helper signatures (injected deps abbreviated)

```ts
// call-state-repo.ts
upsertCallState(pool, input: CallStateInsert, log?): Promise<CallStateRow>
getCallState(pool, callId): Promise<CallStateRow | undefined>

// Atomic stage-advance: UPDATE current_stage + append processing_log in ONE tx.
interface AdvanceStageInput {
  callId: string; fromStage?: string;   // optional optimistic guard
  toStage: string; status?: string;
  logEntry: { stage: string; outcome: string; errorCode?: string;
              detail?: JsonValue; failureSnapshot?: JsonValue };
}
advanceStage(pool, input: AdvanceStageInput, log?): Promise<CallStateRow>

// review-queue-repo.ts — idempotent per open/in_review call
enqueueReview(pool, { callId, heldReason: HeldReason, slaDueAt: Date, assignee? }, log?): Promise<ReviewQueueRow>

// operator-actions-repo.ts — before/after snapshots
recordOperatorAction(pool, { reviewQueueId, actor, action: OperatorAction,
                             before: JsonValue|null, after: JsonValue|null }, log?): Promise<OperatorActionRow>

// model-invocations-repo.ts — append-only
recordModelInvocation(pool, { callId, stage, modelId, promptVersion,
                              inputTokens, outputTokens, outcome }, log?): Promise<ModelInvocationRow>

// redaction-findings-repo.ts — idempotent per call (soft-delete-then-insert)
replaceFindings(pool, callId, findings: RedactionFindingInsert[], log?): Promise<void>

// restricted/ — run under restricted_role
// token_vault: envelope-encrypted (encrypt/decrypt, aad=call_id)
putToken(runner: RestrictedRunner, keyProvider, { callId, token, plaintext: Buffer }, log?): Promise<void>
getToken(runner: RestrictedRunner, keyProvider, { callId, token }, log?): Promise<Buffer | undefined>
// match_keys: HMAC digests only — never encrypted, never decrypted
putMatchKeys(runner: RestrictedRunner, { callId, phoneHmac?: Buffer, nameHmac?: Buffer, keyVersion }, log?): Promise<void>
getMatchKeys(runner: RestrictedRunner, callId, log?): Promise<MatchKeyRow[]>
```

### Atomic stage-advance transaction

`sql.ts` provides `withTransaction(pool, fn)`: `connect → BEGIN → fn(client) → COMMIT`,
`ROLLBACK` on throw, `release()` in `finally`. `advanceStage` runs both statements on
the same client:
1. `UPDATE call_state SET current_stage=$toStage, status=coalesce($status,status),
   updated_at=now() WHERE call_id=$callId [AND current_stage=$fromStage] RETURNING *` —
   if `fromStage` given and `rowCount===0`, throw `DalError('DAL_STALE_STAGE')` (rolls
   back).
2. `INSERT INTO processing_log (...)`.

Both commit together or neither does. `restricted-context.ts` uses the same shape but
issues `SET LOCAL ROLE restricted_role` as the first statement after `BEGIN`; the role
reverts to the connection's `app_role` at COMMIT/ROLLBACK, so a pooled connection never
leaks elevated privilege.

## Error handling (forerunner, not a parallel model)

`src/db/errors.ts`: `DalError extends Error` with `readonly code: string` and
`readonly context: Record<string,string>` limited to sanitized fields (table/column
names, `call_id`, SQLSTATE — never values/PII), mirroring `FatalBootError`. Stable
codes: `DAL_VALIDATION_FAILED`, `DAL_STALE_STAGE`, `DAL_QUERY_FAILED`,
`DAL_RESTRICTED_ACCESS_DENIED` (map pg SQLSTATE `42501`). Header comment: "Forerunner of
the Task 2.2 failure model — fold in when it lands; do not roll a parallel model." No
silent catches; no alerting/dedup/severity layer (2.2's job).

## Tests (`test/db/`)

Pool usage split (P1): the **owner pool** (`createOwnerPool`, or the existing
`makePool()` — no role switch, superuser) does all setup (seed `key_versions`, parent
`call_state` rows) and cleanup (`DELETE ... WHERE call_id LIKE 'test-%'` — `app_role`
can't DELETE). The **app pool** (`createAppPool`) drives DAL calls and the isolation
assertions. All DB tests `describe.skipIf(!hasTestDb)`.

1. **`upsert-idempotency.test.ts`** — `call_state`, `clean_transcripts`,
   `structured_knowledge`, `token_vault`, `daily_cost_usage`: write twice (2nd payload
   differs), assert `COUNT(*)===1` (or accumulation for daily_cost) and the row reflects
   the 2nd write. `redaction_findings` / `match_keys`: insert 3, replace with 2, assert
   the repo read (which filters `soft_deleted_at IS NULL`) returns **2 active** rows AND
   an owner-pool count confirms **3 soft-deleted** history rows remain (5 total) — proving
   both the active filter and that history is retained, not hard-deleted. `alert_events`:
   duplicate dedup_key while unacknowledged inserts once.
2. **`advance-stage.test.ts`** — assert `current_stage` moved AND exactly one new
   `processing_log` row for the call. Failure path: force the log insert to throw,
   assert the stage did NOT change (rollback → atomicity). Assert `fromStage` guard
   rejects a stale advance with `DAL_STALE_STAGE`.
3. **`vault-match-key-isolation.test.ts`** —
   - Via the **app pool** (`createAppPool` → `SET ROLE app_role`): assert `current_role`
     is `app_role`, and `SELECT * FROM token_vault` / `match_keys` → SQLSTATE `42501`.
   - `token_vault`: drive `putToken`/`getToken` through `restricted-context.ts` and
     assert a full **encrypt→store→read→decrypt** round-trip returns the original
     plaintext.
   - `match_keys`: drive `putMatchKeys`/`getMatchKeys` and assert the stored HMAC
     `Buffer`s round-trip **byte-for-byte** (no decryption; `putMatchKeys` accepts only
     HMAC Buffers, never raw phone/name).
4. **`operator-action-audit.test.ts`** — `enqueueReview` (with `held_reason` +
   `sla_due_at`), then `recordOperatorAction` with distinct `before`/`after` JSON. Read
   back and assert `before`/`after` jsonb deep-equal, `actor`/`action` persisted, FK to
   `review_queue_id` resolves. Also assert `enqueueReview` called twice for the same
   open call yields one `review_queue` row.
5. **`restricted-import-guard.test.ts`** — static scan of `src/db/` file contents; fail
   if the exact snake_case SQL identifiers `token_vault` / `match_keys` appear **outside
   the allowlist** `src/db/restricted/{token-vault-repo,match-keys-repo,restricted-context}.ts`.
   The scan targets SQL identifiers only, so PascalCase type names (`TokenVaultRow`,
   `MatchKeyRow`) in `schemas/` and the barrels, and kebab-case filenames, are allowed.
   Runs without a live DB (no `skipIf`).

`fileParallelism:false` (existing vitest config) keeps DB tests serial.

## Sequencing

0. Commit this plan into the repo at
   `docs/superpowers/plans/2026-07-01-data-access-layer.md` (matching the existing
   `docs/superpowers/plans/` convention — already prettier-excluded via `.prettierignore`).
1. `enums.ts` + `schemas/*` (all 18) + enum-parity test — pure, no IO.
2. `pool.ts` (`createAppPool` with `SET ROLE app_role` connect handler +
   `createOwnerPool` with no role switch) + `sql.ts` + `errors.ts`.
3. `repositories/*` (upserts, soft-delete-replace, append helpers, `advanceStage`,
   idempotent `enqueueReview`).
4. `restricted/restricted-context.ts` + `token-vault-repo.ts` + `match-keys-repo.ts`.
5. Integration + guard tests (5 files above).
6. Barrel `index.ts`.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm run test` — DB integration tests run when `TEST_DATABASE_URL` points at a live
  Postgres whose login user is a member of the group roles (superuser in CI); they skip
  cleanly otherwise. The `restricted-import-guard` and enum-parity(static portion) tests
  run regardless.
- `npm run format:check` and `npm audit --audit-level=high` before the PR (git
  workflow §7).
