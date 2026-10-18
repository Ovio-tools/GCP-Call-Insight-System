# Project paused — where we left off

Paused on **18 October 2026**. No new calls are being picked up or processed, and
nothing is calling the AI service. **No data was deleted**, and the encryption keys
are still in place, so restarting means switching things back on.

All the code is on `main` (last change: #121, "an emergency is a label, not a
hold"). There is no unfinished work on any branch.

## What is off, what is still on

Everything lives in the project's Railway **`dev`** environment, which runs with
`NODE_ENV=staging`. There is no production deployment yet.

| What it does                                          | Where                            | State                                                                       |
| ----------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Call finder: asks Dialpad for new calls every 15 min  | `reconciliation-cron`            | **Off** (deployment removed)                                                |
| Worker: processes each call and calls the AI service  | `worker`                         | **Off** (deployment removed). The service is kept because it holds the keys |
| Alarm checks for the two above                        | external monitor                 | **Paused**                                                                  |
| Website: status, calls, knowledge base, review, notes | `console-surface`                | Still **on** when this note was written (see open items)                    |
| Daily clean-up of expired private data                | `retention-cron`                 | Should be **on** (see open items)                                           |
| Databases and queue                                   | `Postgres`, `raw-store`, `Redis` | **On**. Keep them                                                           |
| Weekly library-update pull requests                   | `.github/dependabot.yml`         | **Off** (`open-pull-requests-limit: 0`)                                     |

### While paused

- **No Slack alerts about stuck reviews (`REVIEW_QUEUE_STALLED`).** Only the call
  finder raises and sends them, and it is off. The same goes for its other jobs:
  re-sending failed alerts, closing old "transcript missing" holds, and syncing
  reviewed examples. The only thing left that can post to Slack is the daily
  clean-up, and only if a purge fails.
- Calls held in the review queue stay exactly as they are.

### Do not delete

- **The `worker` service, or its `CRYPTO_KEK_MATERIAL` / `CRYPTO_WRAPPED_DEK_MATERIAL`
  variables.** These are the keys to the original (unredacted) transcripts. Deleting
  them makes the original transcripts and the token vault permanently unreadable.
  Redacted data and the knowledge base would survive. Removing a _deployment_ is
  safe; deleting the _service_ is not.
- **`Postgres`, `raw-store`, or `Redis`.**

## How to restart

Follow [`docs/deployment.md`](docs/deployment.md). The pause-specific order is:

1. **Railway CLI.** Log in with the account that owns this project (on 18 Oct the
   laptop's CLI was signed in to a different account that can't see it). Then run
   `railway link` and pick the `dev` environment.
2. **AI key.** If the Anthropic key was switched off or its spending limit
   lowered, restore it. If you created a new key, update `ANTHROPIC_API_KEY` where
   the worker's variable points (check the worker's Variables tab; in July it
   referenced the `sample-validation` service's variable).
3. **Alarms.** Un-pause the worker and call-finder checks in the external monitor.
4. **Worker first.** Run `git checkout main && git pull`, then
   `railway up --service worker`. This also applies any pending database
   migrations. Check that the logs show `worker consuming pipeline jobs` and that
   its alarm check turns green.
5. **Optional catch-up for calls made during the pause.** The finder only looks
   back 45 minutes, so on its own it skips the pause. The backfill tool can't help
   here, because it refuses to run outside `NODE_ENV=production`
   ([`docs/backfill.md`](docs/backfill.md)). Instead, before step 6:
   - set `RECONCILIATION_WINDOW_MINUTES` on `reconciliation-cron` to the minutes
     since the pause plus a margin;
   - let **one** run complete;
   - set it back to `45`.

   This has not been tried at this size. Watch for Dialpad rate limits and for the
   daily AI spending cap (`DAILY_MODEL_COST_CAP_USD`). Calls that go over the cap
   land in the review queue as `cost_cap_held` (runbook: "Model cost cap
   exceeded"), so either raise the cap on purpose for the catch-up or spread it
   over several days.

6. **Call finder.** Run `railway up --service reconciliation-cron`. It only runs on
   the 15-minute tick, not at deploy time. The first run will:
   - send one stuck-review Slack alert for each review item that passed its
     deadline during the pause and hasn't alerted before;
   - re-check Dialpad for "transcript missing" holds older than 24 h, and close any
     that still have no transcript.
7. **Website**, if it was stopped: `railway up --service console-surface`.
8. **Weekly library updates.** In `.github/dependabot.yml`, set npm back to `10`
   and delete the github-actions limit line.

## Open items

**Check now, during the pause**

- **Confirm `retention-cron` exists in Railway and runs daily (04:00 UTC).** The
  July setup notes only mention the worker, the call finder and the website. If the
  clean-up is missing, original transcripts are not being deleted on schedule, and
  it should be deployed (`deploy/railway/retention-cron.json`).
- Confirm the `raw-store` database has **backups turned off** (on purpose; see ADR 0008).
- Decide whether to stop `console-surface` for the pause.
- **GitHub security warnings are off** for this repo: Dependabot alerts are
  disabled and automatic security fixes are paused. With the weekly updates also
  off, nothing is watching the libraries for known vulnerabilities. Turn alerts on
  under Settings → Code security.

**Waiting on GitHub**

- **12 open Dependabot pull requests.** Two need real migration work: #8 (zod 3 → 4)
  and #98 (node-pg-migrate 8 → 9). The rest (#123, #99, #97, #96, #95, #88, #87,
  #85, #52, #50) need a rebase and green CI.
- **Open issues:**
  - #25: migrations can't fully roll back, because `app_role` can't be dropped.
  - #26: duplicate migration timestamp. Probably already fixed when Task 7.3
    merged; check and close.
  - #32, #34–#37: follow-ups for the webhook receiver, which isn't deployed (we use
    the call finder instead).

**Before a production launch**

- Stand up a production environment. Everything today is in `dev`.
- In `dev`, the website connects to the database as the all-powerful `postgres`
  user, not the limited `app_role`. The access limits the migrations define are
  never exercised there (as of Aug 2026).
- Fill in the backup/PITR values in [`docs/backup-retention.md`](docs/backup-retention.md)
  (still `UNKNOWN`), and see the other gaps under "Known gaps" in
  [`docs/deployment.md`](docs/deployment.md).

**Not built yet**

- ServiceTitan write-back (Phase 12).
- The review screen for feedback on technician notes (`note_feedback`).

**Dialpad side**

- One Dialpad agent's calls often come back with no transcript. That is a Dialpad
  issue, not ours (investigated 27 Jul 2026), and it needs a check by a Dialpad
  admin. We have no record of it being resolved.
