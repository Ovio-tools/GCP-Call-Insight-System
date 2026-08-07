# Historical backfill runner (Task 11.2)

The pipeline processes live Dialpad calls (webhook + reconciliation sweep) but cannot pull
**historical** calls that predate deployment. The backfill runner (`src/backfill/`,
`src/scripts/run-backfill.ts`) does that. It is the **highest-volume PII move** in the system, so it
is heavily gated, fully resumable, idempotent, and watched by a dedicated job-style external monitor.

It is designed as **the reconciliation sweep with checkpoints, gates, terminal-completion tracking,
and a job monitor** — reusing the idempotent seed-then-process path, the shared Dialpad rate limiter,
the §0.2 consent-gate check, the advisory-lock pattern, and the alerting machinery.

## Environment restriction (real backfill is production-only)

`assertBackfillEnvironment` (pure, runs before any infra is built):

| `NODE_ENV`             | `--synthetic-dialpad-fixture` | Result                                             |
| ---------------------- | ----------------------------- | -------------------------------------------------- |
| `development` / `test` | any                           | refused — `not_live_environment`                   |
| `staging`              | absent                        | refused — `staging_requires_synthetic`             |
| `staging`              | present                       | **synthetic mode** (fixture-backed, in-process)    |
| `production`           | present                       | refused — `production_no_synthetic`                |
| `production`           | absent                        | **real mode** (seed + enqueue to the shared queue) |

There is no host screen — the **§0.2 consent gates** are the real-data guard. §0.2 keeps Task 11.1
(sample validation) as the one real-data staging exception; 11.2's real historical backfill runs **in
production only, after all §0.2 gates are recorded**.

### Processing model by mode

- **Production (real):** `seedCallStateIfAbsent` (tag `dialpad-backfill`) + track in
  `backfill_run_calls` + `enqueueCall` onto the shared pipeline queue. The worker fleet runs the full
  `runPipeline` — redaction fail-closed is structurally impossible to bypass. The drain phase awaits
  terminal state.
- **Staging synthetic:** `seedCallStateIfAbsent` (tag `dialpad-backfill-synthetic`) + track +
  `runPipeline` **in-process** with production stage handlers wired to a **fixture-backed** Dialpad
  client. **No shared queue is ever constructed** and the real `createDialpadClient` is never built,
  so synthetic work can never be consumed by a real worker.
- **Defense-in-depth:** the worker's job processor refuses/skips any `call_state.source =
dialpad-backfill-synthetic` job (a logged no-op), so even a stray synthetic job on the shared queue
  is never processed.

## Consent gates (§0.2)

`assertBackfillProcessingGates` wraps the shared `checkProcessingGates` helper. The five §0.2
processing gates are always required; the ServiceTitan matching consent is required **only** when the
run writes match keys (`deriveServiceTitanMatchingRequirement`). Match-key write-back is a Phase-12
concern: `--match-keys` fails fast with `match_keys_unsupported` and requires the ST gate in the
derivation, so no unimplemented path runs and the gate is never silently bypassed.

## Window (conclusion time)

The window `[from, to]` means **calls that CONCLUDED in `[from, to]`**. The list query reaches back
`from - BACKFILL_MAX_CALL_MINUTES` (Dialpad's list API filters by START time only). Membership:

- `endedAt` present → include iff `endedAt ∈ [from, to]`.
- `endedAt` absent, recognised active/in-progress state → skip (not concluded).
- `endedAt` absent, otherwise → fail **open** only within a bounded start window: include iff
  `startedAt <= to`; a call with `startedAt > to` and no end is above-window and skipped.

`startedAt` is **required** on every listed item (the scan/watermark axis). A page containing any
item without a parseable `startedAt` fails closed with `missing_started_at` **before** that page is
checkpointed — the watermark never advances over an unorderable page.

## Checkpoint / resume / restart

One cursor-paginated, newest-first scan from `from - maxCall`. Checkpoint JSON lives in the existing
`backfill_runs.last_checkpoint` text column:

```json
{
  "v": 1,
  "phase": "sweep|drain",
  "watermarkStartedAtMs": 1730000000000,
  "callsSeen": 1234,
  "seededTotal": 87,
  "terminalCount": 40
}
```

- **Watermark** = the oldest fully-ingested `startedAt`. Written after each fully-ingested page.
- **Boundary-safe resume:** restart the scan from `from - maxCall`, skip calls `startedAt >
watermark` (**strictly greater** — already ingested), and re-ingest every call at exactly the
  watermark timestamp (idempotent → no gap).
- **Fail-closed on corruption:** a malformed/unparseable checkpoint raises `invalid_checkpoint` and
  refuses to run.

Correctness rests on **idempotency** (seed-if-absent + `call_id`-keyed job) plus full-window coverage
on resume; the watermark is a metadata-scan optimization, not the correctness guarantee.

### Status, concurrency, resume vs restart

Statuses (CHECK-constrained): `running` → (`completed` | `interrupted` | `failed`). `interrupted`
(process/operator stop), `failed` (handled error / checkpoint-write failure), and a stale `running`
are all **resumable**; `completed` is final.

- **Concurrency:** a session-level `pg_try_advisory_lock(8_100_002)` (distinct from retention's
  `8_100_001`) on a dedicated client, held for the entire run (sweep + drain). A second run →
  `already_running`, returns **without** a start ping.
- **Unique resumable invariant:** a UNIQUE partial index on `(window_start, window_end) WHERE status
IN ('running','interrupted','failed')` — at most one resumable run per exact window (`completed`
  excluded, so re-running a finished window is fine).
- **Resume vs create:** no resumable row → `startRun` a fresh run. `--resume <runId>` → continue from
  its checkpoint. A resumable row with neither `--resume` nor `--restart-from-scratch` → refuse
  `resumable_run_exists`. The runner never auto-creates a second run while a resumable row exists.
- **Restart:** `--restart-from-scratch` **requires `--resume <runId>`** and **reuses that row**
  (`resetRun`: `status='running'`, `last_checkpoint = NULL`, delete the run's `backfill_run_calls`),
  then sweeps from the top — no new row, no unique-index conflict.

## Terminal-based completion

Success = seeded/rescued calls **processed to terminal**, not merely enqueued. Every enqueued **or
rescued** call is recorded in `backfill_run_calls (backfill_run_id, call_id)`; the drain phase polls
until every tracked row joins a **terminal** `call_state` (`completed`/`skipped`/`held`/
`review_closed`) **or** a `dead_letter` row. Only then does the terminal success ping fire. A rescued
pre-existing pristine seed (already a `call_state` row) is tracked here and awaited, which
`source_metadata` stamping alone would miss.

Caveat: a call whose transcript is not yet available legitimately stays non-terminal and keeps the
run active; operators backfill concluded historical calls whose transcripts exist, and
`BACKFILL_STALL_THRESHOLD_MS` is generous.

## Rate limits

The runner **reuses** the shared `RedisDualWindowLimiter` + `createDialpadClient`, so both Dialpad
limits (20/sec company-wide, 1200/min transcript endpoint) hold across live worker fetches **and**
backfill list calls together — not per-process.

## Job-style monitor — four distinct signals

`createBackfillMonitor` derives **four distinct** URLs from `BACKFILL_CHECK_URL`:
`start=${base}/start`, `progress=${base}/log`, `success=${base}`, `fail=${base}/fail`. A pairwise
collision after derivation fails at construction, before any ping.

> The progress signal is `/log` because Healthchecks.io only accepts `/start`, `/fail` and `/log`;
> a `/progress` suffix is rejected with `400 invalid url format`. `/log` records an event without
> changing the check's pass/fail state — exactly what a progress ping needs, since only `success`
> may turn the check green.

- `start()` — one start ping; arm the progress interval.
- progress — a periodic ping every `BACKFILL_PROGRESS_INTERVAL_MS` **while** `now - lastProgressAt <=
BACKFILL_STALL_THRESHOLD_MS`; past the stall threshold it **withholds** so the external monitor's
  missing-progress window fires the stall alert.
- `success()` / `fail()` — fire exactly once (terminated-guarded), each to its **distinct** URL, and
  stop the interval. A progress ping can never satisfy the terminal-success monitor.

### Required external-monitor configuration

Provision a **job-style** check for `BACKFILL_CHECK_URL` with the four signal endpoints above:
between runs it is **idle and expects nothing** (no alert when no run is scheduled), and its
missing-progress window must be sized against `BACKFILL_PROGRESS_INTERVAL_MS` so a run that stalls
partway **does** alert. See also `docs/heartbeats.md`.

## Config

| Variable                        | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `BACKFILL_CHECK_URL`            | Base URL for the four derived signal URLs. Required in staging/production. |
| `BACKFILL_MAX_CALL_MINUTES`     | List look-back margin (default 240).                                       |
| `BACKFILL_PROGRESS_INTERVAL_MS` | Progress-ping cadence while active.                                        |
| `BACKFILL_STALL_THRESHOLD_MS`   | Max no-progress time before pings are withheld (generous; default 6h).     |
| `BACKFILL_DRAIN_POLL_MS`        | Delay between drain-phase terminal polls.                                  |

## Usage

```
run-backfill --from <ISO> --to <ISO> [--resume <runId>] [--restart-from-scratch] \
             [--match-keys] [--synthetic-dialpad-fixture <path>]
```

Staging smoke uses `--synthetic-dialpad-fixture` only — the runtime guard refuses a real backfill in
staging, and the fixture-backed client means no real Dialpad data is touched. A checkpoint-write
failure emits `BACKFILL_CHECKPOINT_FAILED` (runbook: `runbook#backfill-checkpoint-failed`) and stops
cleanly at the last good checkpoint; `--resume` continues with no duplicate run row / no duplicate
calls.
