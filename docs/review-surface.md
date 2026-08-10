# Review & admin surface (Task 6.2)

The authenticated surface where OVIO reviewers work the held-call queue. Built on the Task 2.3
shared HTTP hardening/auth middleware (`createInternalApp`), so **auth is enforced by default** —
no route opts out with `config.public`. Boot: `node dist/services/review-surface.js`
(`src/services/review-surface.ts`). Reuses `config.PORT`.

It lists open review items, shows one item with **redacted content by default**, lets an
**elevated** reviewer explicitly reveal raw/vault values (audited), and resolves items via the
**seven actions** — each in one transaction, idempotent, PII-free, with a complete
`operator_actions` audit row.

## Routes

| Method | Path                               | Role         | CSRF | Purpose                                                                                      |
| ------ | ---------------------------------- | ------------ | ---- | -------------------------------------------------------------------------------------------- |
| GET    | `/review` · `/review.json`         | authed       | –    | list open items (safe fields only)                                                           |
| GET    | `/review/:id` · `/review/:id.json` | authed       | –    | one item: redacted-if-available content + safe metadata; `raw_available`; never preloads raw |
| POST   | `/review/:id/actions/:action`      | authed       | ✔    | the seven actions                                                                            |
| POST   | `/review/:id/reveal-raw`           | **elevated** | ✔    | audited raw-transcript (+ `?token=` single vault value) reveal, this call only               |

- **Form factor:** JSON is the contract; the HTML list/detail are **read-only** views. The shared
  middleware checks the `X-CSRF-Token` **header**, which a plain `<form>` cannot set, so every
  state-changing call is JSON with the header; the detail page ships a tiny inline `fetch()`
  submitter that sets it. No middleware change.
- GET routes are read-only (no CSRF); POST routes are CSRF-enforced by the middleware. An
  unauthenticated request to any route is `401 AUTH_REQUIRED`.

## Roles

Any authenticated session is a **base reviewer** (list, detail, and the seven actions). The
raw/vault reveal additionally requires the session's roles to include `REVIEW_ELEVATED_ROLE`
(matched against `request.user.roles`). **Fail-closed:** when `REVIEW_ELEVATED_ROLE` is unset, NO
session is elevated and every reveal is refused `403 AUTH_FORBIDDEN` — elevated reveal is an
explicit per-deployment opt-in.

## Action model (reason/stage-aware)

`src/review/action-matrix.ts` is the single source of truth: `ALLOWED_ACTIONS`,
`REPROCESS_STAGES`, `APPROVE_FORWARD_STAGE`, and `ORIGIN_STAGES`, all total over `HELD_REASON`. An
action not permitted for a held call's reason → `409` (`REVIEW_ACTION_CONFLICT`), no write.

| held_reason             |        approve        | reject | mark_non_customer | mark_spam | correct_extraction | reprocess stages                         | mark_unresolvable |
| ----------------------- | :-------------------: | :----: | :---------------: | :-------: | :----------------: | ---------------------------------------- | :---------------: |
| classifier_uncertain    |      ✓→`extract`      |   ✓    |         ✓         |     ✓     |         –          | classify,extract                         |         ✓         |
| classified_spam         |           –           |   ✓    |         ✓         |     ✓     |         –          | classify                                 |         ✓         |
| malformed_model_output  |           –           |   ✓    |         ✓         |     ✓     |         –          | classify                                 |         ✓         |
| schema_invalid          |           –           |   ✓    |         ✓         |     ✓     |         ✓          | extract                                  |         ✓         |
| redaction_failed        |           –           |   ✓    |         ✓         |     ✓     |         –          | redact                                   |         ✓         |
| residual_pii_detected   |           –           |   ✓    |         ✓         |     ✓     |         –          | redact                                   |         ✓         |
| missing_transcript      |           –           |   ✓    |         ✓         |     –     |         –          | fetch-transcript,transcript-availability |         ✓         |
| cost_cap_held           |           –           |   ✓    |         ✓         |     ✓     |         –          | classify,extract                         |         ✓         |
| weak_servicetitan_match |           –           |   ✓    |         –         |     –     |         –          | –                                        |         ✓         |
| emergency_review        | ✓→`verbatim-pii-scan` |   ✓    |         ✓         |     ✓     |         –          | verbatim-pii-scan                        |         ✓         |

### Handler template (one transaction, no TOCTOU)

Lock the review by `:id` (any status). Then:

1. **Active (`open`/`in_review`):** check `ALLOWED_ACTIONS`; **lock the `call_state` row**; assert
   the first-time-execution guard (`status='held'`, `current_stage` ∈ the reason's `ORIGIN_STAGES`,
   `drop_reason IS NULL` — never resurrects a `completed`/`skipped`/`review_closed` call); run the
   artifact/retention preflight **in-tx**; take the transition; write **one** `operator_actions`
   row with a sanitized `after.action_params` fingerprint; for a reprocess-class action insert the
   outbox row; commit. A guard/preflight miss **throws before any write** → rollback → `409`.
2. **Terminal (`resolved`/`unresolvable`) — idempotency:** a prior audit row with the **same
   action AND the same `action_params`** → no-op success; a different action or different params →
   `409`. (`reject` and `mark_spam` both yield `resolved`+`review_closed`, so the audit trail — not
   the terminal state — disambiguates.)
3. **Any other state** → `409`.

### Transition targets (all runner-invariant-valid)

- **reject / mark_spam** → review `resolved` + `call_state` `review_closed`.
- **mark_non_customer** → review `resolved` + `call_state` `skipped` @ `classify` +
  `drop_reason='classified_non_customer'`.
- **mark_unresolvable** → review `unresolvable` + `call_state` `review_closed`
  (`markUnresolvableByReviewId`, review-id-scoped so a stale id can't touch another active review).
- **reprocess** → resolve the review, move `call_state` to `processing` @ the target stage, re-enter
  the pipeline.
- **approve** → resolve + reprocess forward to completion. `classifier_uncertain` first writes a
  content-free reviewer `customer` classify marker (`detail:{bucket:'customer',
source:'reviewer_approved'}`), then resumes `extract`; `emergency_review` resumes
  `verbatim-pii-scan` (its candidate was already persisted).
- **correct_extraction** (schema_invalid only) → **enums only, no reviewer free text**
  (`problem_statement` forced to `HUMAN_REVIEW_PROBLEM_STATEMENT`, `customer_language=[]`, provenance
  constants `model_id='human-review'`); creates the candidate in-tx, then reprocesses from
  `verbatim-pii-scan` so the gates run and `store` produces the record.

The broadened runner guard (`hasTerminalReviewForCall` → `status IN ('resolved','unresolvable')`)
lets a reconciliation/duplicate re-enqueue of a rejected/spam/unresolvable call no-op instead of
throwing "inconsistent".

## Reprocess durability (outbox)

A reprocess/approve/correct_extraction writes a `reprocess_requests` row **in the state-change
transaction** (`UNIQUE(operator_action_id)` → one per action). After commit the job is enqueued
optimistically with a distinct id `${jobIdForCall}-reprocess-${reviewId}` (never dedups against a
retained completed base job) and the row marked `sent`. A crash/Redis outage leaves the row
`pending`; the **reconciliation cron drains** pending rows after its stalled-review scan
(`FOR UPDATE SKIP LOCKED` + a `call_state` re-check → `sent`/`superseded`), withholding its
heartbeat on an incomplete drain. The requeue-parked scripts do **not** rescue a generic stranded
`processing` row (they only match kill-switch markers), which is why the outbox exists.

## Raw access & the PII stance

Two shared predicates (`src/review/raw-access.ts`):

- `rawRetentionWindowOpen(review, now, config)` = `raw_purged_at IS NULL && now < created_at +
REVIEW_HELD_RAW_RETENTION_CAP_HOURS`. The cap is a **time** limit, so a lagging retention cron can
  leave a past-cap review unpurged; re-pulling raw then would reintroduce PII after the cap.
- `rawTranscriptRevealAllowed(...)` = `rawRetentionWindowOpen(...) && transcriptExists`.

Detail `raw_available`, `/reveal-raw`, and the `transcript-availability`/`redact` reprocess
preflights use `rawTranscriptRevealAllowed`; the `fetch-transcript` preflight uses
`rawRetentionWindowOpen` **only** (fetching a not-yet-present transcript is the point).

- **Detail** shows redacted content only from a **live `clean_transcripts` row** that passes a
  value-level residual scan (`residualScan`, defense in depth over the redact-stage invariant); on a
  hit it is withheld (`residual_pii`), and if there is no live clean row it is withheld
  (`no_clean_transcript`) while actions still work. The four controlled-vocabulary enums show only
  when a completed record exists; there are **no free-text fields**. A serialize-time
  `assertNoContentFields` guard + zod DTO re-validation is the no-egress backstop.
- **Reveal** (elevated) returns the raw transcript (and at most one vault value) in the **response
  body only** — never a log, never the audit row. It writes exactly one `reveal_raw` audit row whose
  sanitized `after` reflects what was revealed: `{revealed:['transcript'], call_id}` or
  `{revealed:['transcript','vault_value'], call_id, vault_token_ref: '[NAME_1]'}` (the token
  **label**, never the decrypted value). A `?token=` from another call is rejected before any
  decrypt (`tokenExistsForCall`, no-decrypt). If the window is closed / raw purged / transcript
  missing → `{raw_available:false}` with **no** audit row (redacted-only resolution still works).

- **Call length.** List and detail both carry `call_duration_ms` (milliseconds, `null` when the
  length was never recorded), rendered as `call length 3 min 42 sec` / `call length unknown` via the
  shared `formatDurationMs` in `src/ui/chrome.ts`. It exists so a reviewer can tell a two-second
  non-call from a genuine four-minute `missing_transcript` hold — the one hold a person often cannot
  resolve, where the call's length is the whole judgement. It is the **only** value read out of
  `call_state.source_metadata`, and it is read through `getCallDurationsMs`
  (`src/db/repositories/call-state-repo.ts`): one batched query selecting the single jsonb key —
  never `source_metadata` itself, never `getCallState`'s `SELECT *` — behind a zod projection that
  admits a finite non-negative number and nulls everything else. That free-form jsonb can carry raw
  call metadata (the same reason `src/status/calls.ts` refuses to read it at all), so the narrowness
  is the de-identification argument, and `test/review/detail.test.ts` asserts a hostile metadata
  value never reaches the response.

No PII or transcript content ever appears in a log line, an unauthenticated or error response, or an
`operator_actions` row.

## Failure code

`AUTH_FORBIDDEN` (403, severity low, owner platform) — an authenticated session lacking the required
elevated role. See `runbook.md#auth-forbidden`.
