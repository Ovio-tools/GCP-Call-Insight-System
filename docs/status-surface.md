# Status surface & alert delivery (Task 7.3)

Two capabilities land here:

1. An **authenticated, mobile-friendly status surface** (`GET /status` HTML, `GET /status.json`
   JSON) showing pipeline health and counts only — never content or PII.
2. **Alert delivery**: `alert_events` rows are now _delivered_ to an outbound Slack-style webhook
   (previously they were only recorded), reliably and exactly once per incident.

Both compose existing shared modules (Task 2.2 failure model, Task 2.3 HTTP middleware, Task 7.1
heartbeats); no surface rolls its own auth, error shaping, severity, or alert formatting.

## Status surface

### Routes

- `GET /status` → `text/html`. Server-rendered, self-contained page (inline CSS, no external
  assets, no JS beyond an optional `<meta http-equiv=refresh>`). Mobile-first, readable at 360px.
- `GET /status.json` → the same `StatusDTO` as JSON.

Both are mounted on `createInternalApp` (auth-by-default): an unauthenticated request is rejected
`401` by the shared middleware. GET-only, so no CSRF concern. Entry point:
`src/services/status-surface.ts`.

### The data contract (`src/status/dto.ts`)

One zod-validated `StatusDTO`. Every field is a label, state, count, timestamp, budget number,
error code, runbook ref, or sanitized summary string — **nothing else can be constructed**. The
allowlist serializer `serializeStatus` (`src/status/serialize.ts`) runs the content-field guard
(`assertNoContentFields`) over the DTO and re-validates it against the schema **before it leaves
the process** — defense in depth mirroring the existing no-PII-egress tests. The aggregation layer
never selects transcript text, vault, clean-transcript bodies, `redaction_findings` values,
`customer_language`, phone, or name — those columns are never in any status query.

### `null` vs `0` — unknown vs zero

Any numeric metric the system does not **know** is `null`, rendered as the word **`unknown`**.
`0` appears only when the query **succeeded** and truly returned zero. The HTML shows `unknown`
(never a blank, never a misleading `0`) and the JSON preserves `null`. Every signal is wrapped so
an error or absence degrades to `unknown` — a broken component never breaks the page reporting on
it.

### Node states

`healthy | idle | degraded | broken | paused | unknown`. Each renders a distinct, **text-labelled**
state (not color-only). The summary `pipeline_state` is
`running | degraded | broken | paused | unknown`.

- A **critical** active alert → `broken`; a non-critical active alert → `degraded`.
- Model pause is **per stage**: classify and extract each have their own kill switch
  (`CLASSIFY_ENABLED` / `EXTRACT_ENABLED`). A stage renders `paused` when its flag is off **or**
  the daily hard cap is reached; the summary `model_paused` is `true` when either stage is
  known-paused, `false` only when both are known not-paused.
- Pause state **unknown** (a stage's flag is on but the cost lookup failed) → that node renders
  `unknown` and `model_paused=null`, rendered `unknown` — never `false`.
- `pipeline_state` is `unknown` only when required summary signals are unavailable and no stronger
  broken/degraded/paused signal exists.

### Fixed nodes

The 9 pipeline stages (always all rendered, `PIPELINE_STAGES` order) and 4 components
(`webhook_receiver`, `worker`, `reconciliation_cron`, `retention_cron`). The DTO-key ↔ DB-stage
mapping lives in `src/status/stages.ts`, built **from** `PIPELINE_STAGES` so it cannot drift; a
guard/test asserts it covers exactly `PIPELINE_STAGES`. Two stage names differ in wording
(`transcript-availability` → `availability_check`, `verbatim-pii-scan` → `second_pii_scan`). An
unrecognized `current_stage` is sanitized-logged and ignored — it never breaks the page.

Held-for-review (with a per-`held_reason` breakdown) and the dead-letter count are first-class,
explicit fields so those backlogs are visible, not lost inside stage counts.

## Component liveness — the in-DB heartbeat mirror

`component_heartbeats` (migration `1782864000010`) is a best-effort in-DB **mirror** of the
external Task 7.1 dead-man's-switch pings, so the status surface can render each component's
last-successful-run and health without reaching the external monitor.

**The external per-component checks stay the authoritative alerting source.** The DB row only feeds
the status surface (CLAUDE.md §5: the status surface may _display_ health but must not replace the
external monitor). A DB-write failure is sanitized-logged and **never** blocks a ping or fails a
run — the ping and the DB write are independent, ordered so the ping is never gated on the write.

### Liveness vs. activity (important)

- **Periodic-liveness components** — `worker`, `reconciliation-cron`, `retention-cron` — emit a
  periodic heartbeat on each successful tick. Only these get **stale-threshold** logic: a
  `last_run_at` older than the component's configured threshold renders `broken`.
  - Worker: on each healthy liveness beat (`WORKER_HEARTBEAT_STALE_MS`).
  - Reconciliation cron: after a fully successful sweep (`RECONCILIATION_HEARTBEAT_STALE_MS`).
  - Retention cron: wired when it gains a successful-run point (`RETENTION_HEARTBEAT_STALE_MS`);
    until then it renders `unknown`.
- **The webhook receiver is a SEPARATE concern.** "Last webhook received" is **activity**, not
  liveness — an idle-but-healthy receiver still receives nothing. Its rendered state comes from a
  boot/periodic **liveness** heartbeat if one exists, else `unknown`; a successful receive may
  update an activity timestamp/count but **never** substitutes for the liveness state, and
  stale-threshold logic never applies to it. (The receiver has no HTTP listener yet, so it renders
  `unknown` today.)

`component_heartbeats.detail` carries **counts only, no PII** — the same content-field guard used
for logs rejects a content field before insert.

## Alert delivery (`src/alerting/`)

`alert_events` rows are recorded deduped by `dedup_key` while unacknowledged, so a **failed first
delivery** must not be lost. Delivery is therefore a **durable, retryable obligation carried by the
row** (migration `1782864000011` adds `delivery_state`, `delivery_attempts`, `next_attempt_at`
(NOT NULL DEFAULT `now()`), `delivered_at`, `last_delivery_error`). Any newly inserted row —
including one from a direct low-level `recordAlert` caller — is `pending` from the moment it exists,
so no producer can persist an undeliverable alert. `delivery_state` carries a DB CHECK constraint
plus an aligned zod enum, so an invalid state can be written from no path.

- **`emitAlert(pool, config, input, deps)`** — the application entry point. Records the alert
  (deduped) and, on a newly inserted row, attempts **immediate** delivery. A duplicate does not
  reset delivery state, so a once-delivered incident is never re-sent. Best-effort: it never throws
  into the producer.
- **Retry sweep** `retryPendingDeliveries` — delivers every row still owed and due
  (`pending`/`failed`, backoff elapsed, under the max-attempts cap) exactly once. Covers a failed
  first delivery **and** any row a direct `recordAlert` caller never attempted. No-ops (logged) when
  `ALERT_WEBHOOK_URL` is unset.
- **Escalation** `escalateAndDeliver` — escalates unacknowledged criticals past
  `ALERT_ESCALATION_WINDOW_MINUTES` (the single source of truth for the window; `windowMs = mins ×
60_000`) and delivers each via the same webhook.
- **Render-from-row** `renderAlertEventText` — the retry sweep has only the row, so the message is
  reconstructed from `alert_events` alone: a full valid `failure_snapshot` renders directly;
  otherwise it reconstructs from `error_code` with **catalog-derived fields always winning** (a
  stale persisted `root_cause_category` recovers instead of failing validation). An unrenderable row
  is marked `failed` with a sanitized error — the sweep never crashes.

Delivered text is the plain-language `renderAlertText` (what broke / cause / impact / remediation /
data-safe / calls-state / runbook / timestamp / environment) and is PII-incapable by construction.
Delivery errors and `last_delivery_error` never contain the webhook URL, a secret, or PII.

### Runner: piggybacks the reconciliation cron

The reconciliation cron runs `escalateAndDeliver` **and** `retryPendingDeliveries` as a
best-effort, Postgres-gated step **before** its outbound Dialpad work, wrapped so it never fails a
successful reconciliation and runs **even when the sweep throws** — exactly when stale criticals
most need to escalate. `ALERT_WEBHOOK_URL` is optional locally (delivery no-ops, rows stay
`pending`, the sweep retries) and fail-fast **required in staging/production** (the cron boot emits
`CONFIG_MISSING_OR_INVALID` naming it).

## Config

| Variable                            | Default    | Purpose                                            |
| ----------------------------------- | ---------- | -------------------------------------------------- |
| `STATUS_PAGE_REFRESH_SECONDS`       | `30`       | `/status` auto-refresh cadence (0 disables)        |
| `WORKER_HEARTBEAT_STALE_MS`         | `180000`   | worker heartbeat staleness → `broken`              |
| `RECONCILIATION_HEARTBEAT_STALE_MS` | `2700000`  | reconciliation staleness → `broken`                |
| `RETENTION_HEARTBEAT_STALE_MS`      | `93600000` | retention (~26h) staleness → `broken`              |
| `ALERT_WEBHOOK_URL`                 | _(unset)_  | Slack-style `{text}` POST target; required in prod |
| `ALERT_WEBHOOK_TIMEOUT_MS`          | `5000`     | delivery POST timeout                              |
| `ALERT_DELIVERY_MAX_ATTEMPTS`       | `6`        | retry cap per row (incl. immediate)                |
| `ALERT_DELIVERY_BACKOFF_MS`         | `60000`    | base for exponential delivery backoff              |

Escalation reuses the existing `ALERT_ESCALATION_WINDOW_MINUTES` — no second window var.

## Manual smoke test

1. Boot `status-surface`, `login`, load `/status` at ~360px: confirm the summary sentence, all 9
   stages + 4 components with states/counts, held + dead-letter sections, spend vs budget.
2. `CLASSIFY_ENABLED=false` → classify/extract render `paused`.
3. Seed a stale `component_heartbeats` row → that component renders `broken`; seed a critical
   `alert_events` row → the summary shows the cause.
4. Point `ALERT_WEBHOOK_URL` at a request-capture endpoint; force a reconciliation/stage failure →
   one delivered plain-language message; repeat → no duplicate; make the endpoint 500 once then
   recover → the retry sweep delivers exactly once; age a critical past the window (while the
   Dialpad sweep is failing) → escalation still records + delivers.
