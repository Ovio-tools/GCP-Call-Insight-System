# Per-component dead-man's switches (Task 7.1)

The worker, reconciliation cron, and retention cron each own a **separate external check**.
Each pings **its own URL** on **its own cadence**. There is deliberately no shared check and
no single "system healthy" URL.

## Why external, and why per-component

- **External, not internal.** The authoritative alarm is an external monitor provisioned
  **outside Railway** (any provider exposing a per-check ping URL — Healthchecks.io, Better
  Uptime, Cronitor, ...). A missed ping is what raises the alert. An internal Railway-only
  heartbeat cannot be the alerting mechanism: if the process, the dyno, or Railway itself is
  down, an internal check is down too and tells no one. The app only ever performs a minimal,
  timed HTTP `GET` against a full URL it is handed — no vendor is hardcoded.
- **Per-component, not shared.** A single shared check would stay **green** as long as _any_
  one component pings it. The worker runs constantly, so a shared check would be kept alive by
  the worker while the reconciliation or retention cron is silently dead — precisely the
  failure the dead-man's switch exists to catch. Separate checks mean a dead cron goes quiet on
  _its own_ check and the monitor names _that_ component.

## The three checks

| Component           | Config variable            | Cadence                              | Pings when                                                                                         |
| ------------------- | -------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| worker              | `WORKER_CHECK_URL`         | every `WORKER_HEARTBEAT_INTERVAL_MS` | it is booted, readiness passed, its run loop is running, and its own consuming connection answers  |
| reconciliation-cron | `RECONCILIATION_CHECK_URL` | once per run                         | the sweep, the SLA-breach scan, the reprocess drain, AND label-sync all complete successfully      |
| retention-cron      | `RETENTION_CHECK_URL`      | once per run                         | the run completes without throwing                                                                 |
| evaluation-cron     | `EVALUATION_CHECK_URL`     | weekly                               | a **live** accuracy run completes fully (`status='complete'`) with ≥1 example evaluated (Task 6.3) |

`WORKER_HEARTBEAT_INTERVAL_MS` (default 60s) and `HEARTBEAT_PING_TIMEOUT_MS` (default 5s) tune
the worker cadence and the per-ping timeout. Set each component's check period/grace on the
monitor **longer** than the component's cadence so a single slow beat does not false-alarm.

**Reconciliation cron is a combined-health cron (Tasks 6.1 / 6.2 / 6.3).** Its entrypoint attempts
FOUR independent duties — the Dialpad metadata sweep, the review-SLA-breach scan, the reprocess-
outbox drain, and **label-sync** (Task 6.3) — and the ping covers **all four**: it fires only when
every duty succeeds. The duties are attempted independently — the scan runs even if the sweep
failed, so overdue held calls still escalate/alert when reconciliation is broken — and **any duty
failing withholds the ping** (a non-zero scan `failed`/`lockedSkipped`, a non-zero drain `failed`,
or a non-zero label-sync `SyncSummary.failed` also counts as incomplete). The `pingSuccess` call
lives in the entrypoint (`runReconciliationCron`) so it is a combined-health signal, not coupled to
the sweep alone.

**Label-sync outcomes and the ping (Task 6.3).** Label-sync mines resolved review decisions into
the labeled corpus. Only an **operational failure** — a nonzero `SyncSummary.failed` (a repository
insert / gate crash) or a throw — withholds the ping, because that is the signal that label capture
is broken. The **expected** per-candidate outcomes (accepted, pii-rejected, schema-rejected,
`missing_clean`, already-present) do NOT fail the cron. Running label-sync here (every 15 min) keeps
capture well inside the shortest CLEAN soft-purge window — **the label-sync cadence must be shorter
than the CLEAN soft-purge window.**

**Evaluation cron (Task 6.3).** The weekly accuracy check pings `EVALUATION_CHECK_URL` only on a
`mode='live'`, `status='complete'` run with ≥1 example evaluated. A partial (mid-run cost cap /
kill), skipped, stub, disabled, or failed run does **not** ping — the missed check is the alert. It
uses its external check only; there is no status-surface mirror for it.

## Rules

- **Fail fast in staging & production.** Each component calls `requireCheckUrl(config, <component>)`
  at boot. If its own URL is missing in staging or production, boot exits with
  `CONFIG_MISSING_OR_INVALID` **naming that component's exact variable** — a component never
  runs unmonitored. Dev and test may omit the URLs; the ping is simply skipped, and tests
  inject fake pingers.
- **Success-only for crons.** A cron pings **only after** its run fully succeeds. If the run
  fails, exits early, or throws, it does **not** ping — the missed external check is the alert.
- **Worker heartbeat is liveness, not throughput.** An idle-but-healthy worker still beats.
  Each beat is gated on the actual consumer: the BullMQ run loop must still be running **and**
  the worker's **own** consuming connection must answer a Redis ping (not a side/producer
  connection — a healthy producer link must never keep a dead consumer looking alive). If the
  run loop has stopped or the consuming connection is unreachable, the beat is skipped so the
  worker stops looking alive. A run loop that outright rejects is unrecoverable in-process: the
  worker logs and exits nonzero so the platform restarts it, and the missed check alerts in the
  gap. The worker pings **only** `WORKER_CHECK_URL` — never a cron's check — and beats regardless
  of `WORKER_KILL_SWITCH` (a kill-switched worker is intentionally not running yet still a live
  process, so its run-loop gate is skipped and only its Redis reachability is checked).
- **No PII, ever, in a ping or its error.** A ping-transport failure is logged as sanitized
  operational context: the component name and a coarse reason only. The check **URL**, secrets,
  transcript content, `customer_language`, phone numbers, names, and any customer data are
  never logged. The transport (`httpPing`) normalizes every failure into a `HeartbeatPingError`
  carrying only an HTTP status number or a coarse reason (`timeout`, an error class name), and
  `sanitizePingError` trusts only those messages — a URL embedded in a raw `fetch` network
  error can never escape.

## Component identity is structural

`src/heartbeat/checks.ts` holds a single `component → check-URL variable` map. URLs are resolved
only through `checkUrlFor` / `checkUrlVar`, and each emitter (`startLivenessHeartbeat`,
`pingSuccess`) is bound to exactly one `(component, url)` pair at construction. There is no code
path that can route one component's ping to another component's URL. `test/heartbeat/checks.test.ts`
asserts the crosstalk guard directly.

## Staging smoke-test procedure

Goal: prove each component's check alerts **independently**, naming the right component, using
**shortened non-production monitor cadences** so a stall is visible in minutes, not a day.

Prerequisites:

- A staging deploy of all three components with `WORKER_CHECK_URL`, `RECONCILIATION_CHECK_URL`,
  and `RETENTION_CHECK_URL` each pointing at a **distinct** staging check on the external monitor.
- On the monitor, set each staging check's period + grace short (e.g. worker period 1 min /
  grace 2 min; each cron period a few minutes) and label each check with its component name
  (`worker`, `reconciliation-cron`, `retention-cron`).
- Set `WORKER_HEARTBEAT_INTERVAL_MS` on staging shorter than the worker check's grace (e.g. 30s).

Scenario A — worker healthy while reconciliation is stalled:

1. Leave the worker running normally; confirm the **worker** check is green and stays green.
2. Stall the reconciliation cron: pause its Railway schedule, or point `DIALPAD_BASE_URL` at an
   unreachable host so every sweep throws before the success ping.
3. Wait past the reconciliation check's grace.
4. **Expect:** the **reconciliation-cron** check alerts (missed ping) and names
   `reconciliation-cron`; the **worker** check is still green; the **retention** check is
   unaffected.
5. Restore the schedule/config; confirm the next successful sweep re-greens the reconciliation
   check.

Scenario B — retention stalled, independent alert:

1. With worker and reconciliation healthy, stall the retention cron: pause its schedule (or, once
   Task 8.1 lands, inject a failing purge in staging) so no run reaches the success ping.
2. Wait past the retention check's grace.
3. **Expect:** the **retention-cron** check alerts and names `retention-cron`; the worker and
   reconciliation checks stay green.
4. Restore; confirm the next successful run re-greens the retention check.

Log check (both scenarios): confirm no ping log line contains a check URL, a secret, transcript
content, `customer_language`, a phone number, or a name — only the component name and a coarse
reason.

## Task 7.3 (status surface) — the in-DB heartbeat mirror

Task 7.3 added `component_heartbeats`, a **best-effort in-DB mirror** of these pings so the status
surface can render component health without reaching the external monitor. It does **not** change
this contract: the external per-component monitor stays authoritative for raising alerts, and a DB
mirror-write failure is sanitized-logged and **never** blocks a ping or fails a run — the ping and
the DB write are independent, ordered so the ping is never gated on the write (worker: after the
ping on each healthy beat; reconciliation cron: before the ping on a successful sweep). The status
surface is a convenience view, not a dead-man's switch — if it is down it must not silence the
external alarm.

**Liveness vs. activity** carries over to the mirror: only the periodic-liveness components
(`worker`, `reconciliation-cron`, `retention-cron`) get stale-threshold → `broken` logic. The
webhook receiver is never marked `broken` from inbound-traffic idleness — its rendered state comes
from a boot/periodic liveness heartbeat if one exists, else `unknown`. See `docs/status-surface.md`.
