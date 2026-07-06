# Security audit — cross-cutting surface review (Task 9.1)

A cross-cutting security audit and shared test suite over **every** public/internal HTTP surface.
Task 9.1 depends on 3.2, 6.2, 7.3, and 10.1 and runs after the surfaces exist. All four are merged
on `origin/main` (tip `ca39d05`), so this is a **complete Task 9.1**: every dependency surface gets a
real cross-cutting suite here, and the audit signs off once all four pass the matrix with no open
`blocking-*` finding. Only ServiceTitan (Task 12.1, Phase 12) remains a gated `describe.todo`
placeholder — it does **not** gate 9.1 signoff.

The suite lives under `test/security/`; run it with `npm run test:security` (CI already runs it via
`npm run test`). `conformance.test.ts` is DB-less and always runs; the surface suites are
`skipIf(!hasTestDb)` locally but run in CI with Postgres/Redis available.

## Precondition-gate probe (re-verified at implementation time)

The route-discovery scanner in `conformance.test.ts` classifies every candidate surface. Result on
`origin/main` (`ca39d05`):

| Surface               | Boot service                        | Factory  | Probe result            | Status   | liveSuite                             |
| --------------------- | ----------------------------------- | -------- | ----------------------- | -------- | ------------------------------------- |
| status (7.3)          | `src/services/status-surface.ts`    | internal | `live-listener-present` | **live** | `internal-surfaces`                   |
| review (6.2)          | `src/services/review-surface.ts`    | internal | `live-listener-present` | **live** | `internal-surfaces`                   |
| knowledge-base (10.1) | `src/services/knowledge-surface.ts` | internal | `live-listener-present` | **live** | `internal-surfaces`                   |
| dialpad-webhook (3.2) | `src/services/webhook-receiver.ts`  | webhook  | `live-listener-present` | **live** | `dialpad-webhook-surface`             |
| servicetitan (12.1)   | _(not built)_                       | webhook  | `absent`                | planned  | `servicetitan-webhook-surface` (todo) |

## Architecture

All HTTP protection comes from the Task 2.3 shared factories in `src/http/`:

- **`createInternalApp`** — helmet/CORS → tier-1 IP rate limit → session → `requireAuth` → tier-2
  user rate limit → `requireCsrf` → handler → sanitized error handler. Auth is on by default; a route
  opts out only with `config.public` (no live route does).
- **`createWebhookApp` + `registerWebhook`** — helmet/CORS → per-provider rate limit → raw-body parse
  → signature → timestamp → replay reserve → handler → commit/release → sanitized errors.

The DB-less `conformance.test.ts` guard fs-scans `src/**` and fails if any file **outside**
`src/http/` rolls its own hardening, if any route declaration is missing from the registry, or if any
listener-binding service is not a live surface joined to a real `liveSuite`.

## Route / surface inventory

| Surface         | Method | Path                              | Kind     | Entry point               | Auth                          | State change / side effects                              |
| --------------- | ------ | --------------------------------- | -------- | ------------------------- | ----------------------------- | -------------------------------------------------------- |
| status          | GET    | `/status`                         | internal | `createInternalApp`       | session                       | none (read-only)                                         |
| status          | GET    | `/status.json`                    | internal | `createInternalApp`       | session                       | none (read-only)                                         |
| review          | GET    | `/review`, `/review.json`         | internal | `createInternalApp`       | session                       | none (read-only)                                         |
| review          | GET    | `/review/:id`, `/review/:id.json` | internal | `createInternalApp`       | session                       | none; detail never preloads raw/vault                    |
| review          | POST   | `/review/:id/actions/:action`     | internal | `createInternalApp`       | session + CSRF                | one-tx action, one audit row, optional reprocess enqueue |
| review          | POST   | `/review/:id/reveal-raw`          | internal | `createInternalApp`       | session + CSRF + **elevated** | raw/vault reveal (call-scoped), one audit row            |
| knowledge-base  | GET    | `/knowledge`, `/knowledge.json`   | internal | `createInternalApp`       | session                       | none; reads only `structured_knowledge`                  |
| knowledge-base  | GET    | `/knowledge/export.csv`, `.json`  | internal | `createInternalApp`       | session                       | none; all filtered rows, capped                          |
| dialpad-webhook | POST   | `/webhooks/dialpad`               | webhook  | `buildWebhookReceiverApp` | HS256 signature               | call_state seed + minimized audit row + one enqueue      |
| servicetitan    | POST   | _(Task 12.1 — planned)_           | webhook  | _(future)_                | signature                     | _(future)_                                               |

## Security test matrix

Expected codes are derived from the exported `httpStatusFor`/`toHttpError` (no source-text parsing);
`conformance.test.ts` pins each. `✓` = a real covering test; `n/a` = not reachable on this surface
(read-only routes accept no body; the factory-level guarantee is proven once in the internal factory
contract block and on review's real POST routes).

| Check → expected code                                                  | status         | review                | knowledge  | dialpad             |
| ---------------------------------------------------------------------- | -------------- | --------------------- | ---------- | ------------------- |
| missing auth/signature → `AUTH_REQUIRED` / `WEBHOOK_SIGNATURE_INVALID` | ✓              | ✓                     | ✓          | ✓                   |
| invalid/tampered/`alg:none` signature → `WEBHOOK_SIGNATURE_INVALID`    | —              | —                     | —          | ✓                   |
| insufficient role → `AUTH_FORBIDDEN`                                   | n/a            | ✓ (reveal)            | n/a        | n/a                 |
| missing CSRF (state change) → `CSRF_TOKEN_INVALID`                     | n/a            | ✓                     | n/a        | n/a                 |
| malformed body → `REQUEST_MALFORMED`                                   | contract       | ✓                     | contract   | ✓                   |
| malicious payload/query (per `maliciousPolicy`)                        | ✓              | ✓                     | ✓          | ✓                   |
| oversized → `REQUEST_BODY_TOO_LARGE`                                   | contract       | ✓                     | contract   | ✓                   |
| bad content-type → `UNSUPPORTED_MEDIA_TYPE`                            | contract       | ✓                     | contract   | ✓                   |
| tier-1 rate limit → `RATE_LIMIT_EXCEEDED`                              | ✓              | ✓                     | ✓          | ✓ (per-provider)    |
| stale/future timestamp → `WEBHOOK_TIMESTAMP_INVALID`                   | —              | —                     | —          | ✓                   |
| replay/duplicate → `WEBHOOK_REPLAY_DETECTED`                           | —              | reprocess idempotency | —          | ✓                   |
| unknown route → 404 `NOT_FOUND`                                        | ✓              | ✓                     | ✓          | —                   |
| unexpected throw → `INTERNAL_ERROR` (PII-free)                         | contract       | contract              | contract   | ✓ (handler failure) |
| PII egress (body + logs + audit/alert rows)                            | ✓ (finding #8) | ✓                     | ✓ (corpus) | ✓                   |

_contract_ = proven by the always-on `shared internal factory contract` block (a scratch
`createInternalApp` POST route + a throwing route), which exercises the exact factory the read-only
surfaces inherit. ServiceTitan is a `describe.todo` row: `future / gated on 12.1 prerequisites (12.0,
addendum, API access, consent)` — it does not gate 9.1 completion.

**Both** state-changing review routes go through the hardening matrix (`runStatePathHardening`):
`POST /review/:id/actions/:action` (full, incl. malicious-body rejection → `REQUEST_MALFORMED`) and
`POST /review/:id/reveal-raw` (CSRF / oversized / malformed / media-type, each proven to reject
before `performReveal` — no raw/vault reveal, no `operator_actions` row). reveal-raw's malicious-body
**rejection** case is skipped because the route's only input is the `?token=` query param and it does
not read its request body — see finding #4 below (a nonblocking body-strictness follow-up).

The Dialpad `liveSuite` proves the DB/queue side effects **within `test:security`**: a DB-backed test
drives the real `createPgIngestSink` (with a stub queue) through the assembled receiver and asserts a
signed event seeds `call_state` at stage 0, writes exactly one minimized `raw_webhook_events` row
(allowlisted metadata + `phone_hmac`/`name_hmac`, no raw PII, no transcript), and enqueues once; an
invalid-signature event writes nothing and enqueues nothing. (The FakeSink cases still prove the
route→sink handoff and the minimization contract; `test/dialpad/pg-ingest-sink.test.ts` proves the
sink in isolation.)

### Net-new vs. already-covered (Dialpad)

Task 3.2's `test/dialpad/webhook-route.test.ts` already covers the happy path, wrong-secret,
tampered, replay, stale, missing-call-id, oversized, and the storage-minimization contract. The 9.1
`dialpad-webhook-surface.test.ts` adds the **matrix lens** and fills gaps by REUSING those helpers:
net-new here are the `alg:none` forgery, the shared `tamperJwt` variant, the non-JWT body case, and
the full `PII_SEEDS` battery over response **and** logs on both accepted and rejected events.

## Findings

Severity classes: **blocking-bypass** (a live surface skips Task 2.3 middleware) → must fix in this PR
or be accepted as an explicit blocker; **blocking-PII-leak** → same; **nonblocking-hardening** →
documented, owner assigned, not fixed here; **doc-only** → recorded.

| #   | Surface / file:route                                         | Class                 | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Proposed fix                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner         |
| --- | ------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | review — `src/review/routes.ts` `/reveal-raw?token=`         | nonblocking-hardening | The vault token label travels in the query string, so it can land in an access log even though the reveal itself is elevated-gated + audited.                                                                                                                                                                                                                                                                                                                | Move the token to the POST body (already CSRF-protected); or scrub `token` from any upstream access-log config. **Flag-only per Task 6.2 — not fixed here.**                                                                                                                                                                                                                                                                        | review (6.2)  |
| 2   | review — `src/review/routes.ts` `sendDomainError`            | doc-only              | A second response-shaping path (`NOT_FOUND` / `REVIEW_ACTION_CONFLICT`) exists beside the shared error handler.                                                                                                                                                                                                                                                                                                                                              | Verified it emits only `{error, message, request_id}` with a curated `err.publicMessage` (no raw error text). No change needed; recorded so a future edit keeps it PII-free.                                                                                                                                                                                                                                                        | review (6.2)  |
| 3   | dialpad — `src/dialpad/webhook/route.ts` content-type parser | doc-only              | The receiver calls `removeAllContentTypeParsers`/`addContentTypeParser` — tokens the conformance guard flags as "self-rolled hardening".                                                                                                                                                                                                                                                                                                                     | Confirmed legitimate: it installs a raw-**body** parser so a bare-JWT body is not rejected as malformed JSON, sitting ON TOP of `createWebhookApp` (not a bypass). **TOKEN-level** allowlist in `conformance.test.ts` — only those two parser tokens are exempt for that one file, each expected exactly once; a new `addHook`/`setErrorHandler`/`fastify()`/`bodyLimit`/second-parser call in the same file still fails the guard. | webhook (3.2) |
| 4   | review — `src/review/routes.ts` `/reveal-raw` request body   | nonblocking-hardening | reveal-raw does not parse its request body (its only input is the `?token=` query param), so a non-empty/malicious body is ignored rather than rejected. Not a bypass or PII leak: CSRF/oversized/malformed/media-type are still enforced by the shared factory (proven in `internal-surfaces.test.ts`), the reveal stays elevated-gated + audited + call-scoped, and Fastify's parser does not pollute the prototype — a body carries no injection surface. | For strict consistency with the sibling terminal actions, parse `emptyBodySchema.safeParse(request.body ?? {})` in the reveal-raw handler before `performReveal`, rejecting a non-empty body with `REQUEST_MALFORMED`. **Flag-only in 9.1 (Task 6.2 owns the route; not a blocking finding) — not fixed here.**                                                                                                                     | review (6.2)  |

**No `blocking-bypass` or `blocking-PII-leak` finding was discovered.** Task 9.1 can be signed off.

### Positive findings (defenses verified)

- **Error shaping** — every rejection returns exactly `{error, message, request_id}`; remediation,
  owner, runbook, and `context` go only to the structured log. The catch-all maps any unexpected
  throw to `INTERNAL_ERROR` and never logs `error.message` or a raw URL/query string.
- **Constant-time compares** — webhook signature verification uses `timingSafeEqualHex`; the Dialpad
  JWT verifier is alg-pinned (HS256) and refuses `alg:none`.
- **Session / CSRF** — session is server-side + revocable (Redis in prod; the in-memory fallback is
  refused in staging/production), a non-secure cookie is refused in staging/production, and every
  state-changing route is CSRF-gated by the shared `requireCsrf`.
- **Fail-closed config** — required secrets (`SESSION_SECRET`, `DIALPAD_WEBHOOK_SECRET`,
  `DIALPAD_PII_HASH_SECRET`) fail registration with `CONFIG_MISSING_OR_INVALID` naming the variable.
- **PII egress** — status reads only counts/states/catalog text (no raw `failure_snapshot` detail,
  assignee, or clean-transcript body); KB scrubs every output shape through the deny-list residual
  guard and touches only `structured_knowledge`; the review detail never preloads raw/vault and the
  reveal audit row records field names + call_id + token label, never plaintext; HTML output is fully
  entity-escaped (no reflected-XSS surface).

## Completion checklist (Task 9.1)

- [x] status, review, Dialpad, KB each pass the cross-cutting matrix via their real suites
      (`internal-surfaces` for status/review/KB; `dialpad-webhook-surface` for Dialpad).
- [x] KB labeled-PII-corpus absence proven across `/knowledge.json`, `export.csv`, `export.json`, and
      the summary; no restricted (`raw_transcripts`/`token_vault`/`match_keys`) reads.
- [x] Conformance guard covers every live route (all four surfaces) via `SURFACES.routes`, plus the
      error-code contract, the services↔surfaces cross-check, and live/planned integrity.
- [x] Only ServiceTitan remains a `describe.todo` placeholder (does not gate signoff).
- [x] No open `blocking-bypass` / `blocking-PII-leak` finding.

## Extension-point contract

The registry `test/security/_registry.ts` (`SURFACES`) is the single source of truth and the guarded
extension point. To add a surface:

1. Register it in `SURFACES` with its `bootFile`, `factory`, `routes[]` (each with `maliciousPolicy`),
   `sharedFactorySuite`, and `liveSuite`. The conformance guard fails if a discovered route or a
   listener-binding service is not represented.
2. While it is only planned, set `status:'planned'` with a `plannedPlaceholder`, and add the matching
   `describe.todo` in `planned-surfaces.test.ts` (its names are derived from the registry, so they
   cannot drift). The conformance guard pins the planned set and forbids a live surface lingering as a
   todo.
3. When it goes live, flip `status:'live'`, point `liveSuite` at its **real** suite (never
   `webhook-conformance` for a webhook surface — that is a synthetic factory proof only), and add that
   suite: internal surfaces join `internal-surfaces.test.ts`; a new webhook surface gets its own
   `*-webhook-surface.test.ts` driving the real receiver + DB/queue side effects through the matrix.
