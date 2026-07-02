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

| Component           | Config variable            | Cadence                              | Pings when                                                    |
| ------------------- | -------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| worker              | `WORKER_CHECK_URL`         | every `WORKER_HEARTBEAT_INTERVAL_MS` | it is booted, readiness passed, and the queue's Redis answers |
| reconciliation-cron | `RECONCILIATION_CHECK_URL` | once per run                         | the sweep completes fully successfully                        |
| retention-cron      | `RETENTION_CHECK_URL`      | once per run                         | the run completes without throwing                            |

`WORKER_HEARTBEAT_INTERVAL_MS` (default 60s) and `HEARTBEAT_PING_TIMEOUT_MS` (default 5s) tune
the worker cadence and the per-ping timeout. Set each component's check period/grace on the
monitor **longer** than the component's cadence so a single slow beat does not false-alarm.

## Rules

- **Fail fast in staging & production.** Each component calls `requireCheckUrl(config, <component>)`
  at boot. If its own URL is missing in staging or production, boot exits with
  `CONFIG_MISSING_OR_INVALID` **naming that component's exact variable** — a component never
  runs unmonitored. Dev and test may omit the URLs; the ping is simply skipped, and tests
  inject fake pingers.
- **Success-only for crons.** A cron pings **only after** its run fully succeeds. If the run
  fails, exits early, or throws, it does **not** ping — the missed external check is the alert.
- **Worker heartbeat is liveness, not throughput.** An idle-but-healthy worker still beats.
  Each beat is gated on a dependency probe (the queue's Redis ping); if the probe fails or
  throws, the beat is skipped so a worker that can no longer reach Redis stops looking alive.
  The worker pings **only** `WORKER_CHECK_URL` — never a cron's check — and beats regardless of
  `WORKER_KILL_SWITCH` (a kill-switched worker is still a live process).
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

## Follow-up for Task 7.3 (status surface)

The status surface may **display** component health and last-run/last-ping for each component
(read from the DB or, read-only, from the monitor's status API). It must **not** become the
alerting source: the external per-component monitor stays authoritative for raising alerts. The
status surface is a convenience view, not a dead-man's switch — if the surface itself is down it
must not silence the external alarm.
