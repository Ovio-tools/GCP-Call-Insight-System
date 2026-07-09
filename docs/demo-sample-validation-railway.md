# Client demo on Railway — sample-validation job (Task 11.1)

**Goal:** open Railway, trigger a job, and show the client real Dialpad transcripts being
redacted → classified → extracted → **stored in the DB**, plus a **PII-free report** in the logs.

**Scope:** staging / client-demo readiness — **NOT production launch.** This uses the one §0.2
consented exception (Task 11.1). It is the only sanctioned way to run **real** customer data in
staging. Production live processing stays blocked (needs the §6.1 launch gates + the production KMS,
Task 8.2b). Do **not** run the live services (webhook / worker / reconciliation-cron) on real calls
for this — that is live processing outside §0.2.

## Why a job and not the live services

The sample-validation harness runs the **full existing pipeline inline** (fetch → redact →
classify → extract → store) for a bounded set of calls, then builds a report only from
de-identified stores. It refuses to run unless three guards pass, in order, **before any Dialpad
fetch or model call** (`src/sample-validation/`):

1. `NODE_ENV=staging`
2. no configured host contains `prod` / `production` (`DATABASE_URL`, `REDIS_URL`,
   `DIALPAD_BASE_URL`, `OIDC_ISSUER_URL`)
3. the five §0.2 consent gates are recorded in `consent_gates`

Because it runs the pipeline in-process, you do **not** deploy a separate worker, webhook, or the
external heartbeat check URLs. You deploy **Postgres + Redis + this one job**.

## What you view at the end

- **Service logs** — the harness prints a PII-free JSON report (redacted text + the extracted
  record + prompt/model/schema versions). Safe to screen-share.
- **Postgres (Railway data tab or `psql`)** — the stored rows:
  - `call_state` (status/stage per call), `clean_transcripts` (redacted text + risk score),
    `structured_knowledge` (the extracted record — the durable asset), `redaction_findings`.
  - Raw transcript text lives encrypted in `raw_transcripts` / `token_vault` and is **not** in the
    report by construction.

---

## One-time setup

### 1. Project + data stores

1. New Railway project (this is your **staging** project — keep it separate from any prod project).
2. Add **Postgres** and **Redis** plugins. Turn on Postgres PITR + Redis persistence.
3. Do **not** name the database/instances with `prod`/`production` — the no-production-resource
   guard screens the hostname and will refuse the run. Use `staging`-style names.

### 2. The sample-validation service

1. New service from this repo. Set its **Config-as-code path** to
   `deploy/railway/sample-validation.json`.
2. Attach a **persistent Volume** to this service, mounted at `/data/keystore`.
   > This is required: the staging keystore (`LocalFileKeyStore`) writes KEK + wrapped-DEK **files**
   > to disk, and Railway container filesystems are ephemeral. Without a volume, the keys the
   > pipeline needs to envelope-encrypt raw transcripts vanish between runs and redaction fails
   > closed. The volume is single-service, which is why bootstrap (below) and the job run here.
3. Wire `DATABASE_URL` and `REDIS_URL` as reference variables from the Postgres/Redis plugins.

### 3. Environment variables

Set these on the service (Railway → Variables). The process **names any missing/invalid var at boot**
with `CONFIG_MISSING_OR_INVALID`, so if boot fails, read the log line and add what it names.

| Variable                   | Value                        | Why                                                      |
| -------------------------- | ---------------------------- | -------------------------------------------------------- |
| `NODE_ENV`                 | `staging`                    | Guard 1; also forbids the file-less `local` key provider |
| `DIALPAD_BASE_URL`         | `https://dialpad.com/api/v2` | transcript fetch (re-confirm current)                    |
| `DIALPAD_API_KEY`          | _(real key)_                 | pipeline fetches each call's transcript                  |
| `ANTHROPIC_API_KEY`        | _(real key)_                 | classify (Haiku) + extract (Sonnet)                      |
| `CLASSIFY_ENABLED`         | `true`                       | ships `false`; enable to run classify                    |
| `EXTRACT_ENABLED`          | `true`                       | ships `false`; enable to run extract                     |
| `REDACTION_VALUE_HASH_KEY` | _(base64, ≥32 bytes)_        | required by the redaction stage                          |
| `CRYPTO_KEY_PROVIDER`      | `keystore`                   | `local` is refused in staging                            |
| `CRYPTO_KEY_STORE_DIR`     | `/data/keystore`             | the mounted volume                                       |
| `CRYPTO_KEK_VERSION`       | `kek-1`                      | bootstrap seed KEK version                               |
| `SAMPLE_CALL_IDS`          | `id1,id2,id3`                | the real Dialpad call ids the job processes (see below)  |

Generate a hash key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Model ids, Dialpad rate limits, and the daily cost cap have safe defaults — re-confirm the model
ids are current before a real run. Leave `OIDC_ISSUER_URL` unset (or a non-`prod` staging value);
this job serves no HTTP.

### 4. First deploy (build + migrate)

Deploy the service once. The build runs `npm ci && npm run build && npm run model:fetch` (vendors
the NER model into the image — redaction needs it), and `preDeployCommand` runs `npm run db:migrate`
against the staging DB. The **run itself will fail** at this point — that's expected: the keystore
isn't bootstrapped and the consent gates aren't recorded yet.

### 5. Bootstrap the keystore (one-time, on the volume)

The keys must be written **on this service's volume**, so run bootstrap here, once:

- Temporarily set the service **start command** to:
  ```
  node dist/scripts/bootstrap-key.js --actor ops@ovio --approval-ref DEMO-1
  ```
  Deploy, confirm the log shows a successful `key_bootstrapped`, then **restore** the start command
  to the config-as-code default (`run-sample-validation.js …`). (`bootstrap-key` refuses to run
  twice, so leaving it in place would fail every later run.)
- Details: `docs/key-hierarchy.md`.

### 6. Record the five §0.2 consent gates

Record each of the five §0.2 processing consent gates with the operator command
(one per gate, each with a one-line evidence note pointing at the signed
document / confirmation):

```bash
npm run record-consent -- --gate dialpad_recording_consent \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate signed_services_agreement \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate signed_data_processing_addendum \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate anthropic_no_training_confirmation \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate anthropic_data_retention_confirmation \
  --by "<your name>" --note "<where the proof lives>"
```

The command refuses an unknown gate name, skips a gate that is already recorded,
and after each run prints which required gates remain — so you know when the gate
is fully cleared. Verify:

```sql
SELECT gate_type, count(*) FROM consent_gates
WHERE gate_type IN (
 'dialpad_recording_consent','signed_services_agreement','signed_data_processing_addendum',
 'anthropic_no_training_confirmation','anthropic_data_retention_confirmation')
GROUP BY gate_type;   -- expect all five present
```

`servicetitan_matching_consent` is **not** needed (no `--servicetitan`; Phase 12 is out of scope).

---

## Running the demo

1. Pick 2–5 real Dialpad call ids that have transcripts, and set `SAMPLE_CALL_IDS` to them
   (comma-separated). The bounded cap is 25.
   > `--size N` (recent calls) reads already-ingested `call_state` rows, so it finds nothing on a
   > fresh DB. Use an explicit id list (`SAMPLE_CALL_IDS`) for the first runs.
2. **Trigger the run:** click **Redeploy** (or Restart) on the sample-validation service. It runs to
   completion and exits (`restartPolicyType: NEVER`).
3. **Show the logs:** the service prints the PII-free side-by-side report (redacted text + extracted
   record). Screen-share it.
4. **Show the DB:** in the Postgres data tab (or `psql`), show `structured_knowledge`,
   `clean_transcripts`, and `call_state` for those call ids — the transcripts processed and stored.
5. Re-running is idempotent by call id: it updates, never duplicates.

Optional: mark a sample correct/wrong to seed the labeled baseline —
`node dist/scripts/mark-sample.js …` (see `docs/sample-validation.md`).

## Troubleshooting

| Symptom                                                                       | Cause / fix                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `not_staging`                                                                 | `NODE_ENV` isn't `staging`.                                                                                                   |
| `production_resource`                                                         | a `DATABASE_URL`/`REDIS_URL`/`DIALPAD_BASE_URL`/`OIDC_ISSUER_URL` **host** contains `prod`/`production`. Rename the instance. |
| `missing_consent_gates` (with `context.missing`)                              | seed the listed gate types (step 6).                                                                                          |
| `keystore not ready: expected exactly one active KEK/DEK … run bootstrap-key` | do step 5; confirm the volume is mounted at `CRYPTO_KEY_STORE_DIR`.                                                           |
| `CONFIG_MISSING_OR_INVALID: <VAR>`                                            | set the named var (step 3).                                                                                                   |
| `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE`                                  | store not reachable — check the reference variables and that the plugins are up.                                              |
| redaction holds everything / `REDACTION_*` error                              | `model:fetch` didn't run, or `REDACTION_VALUE_HASH_KEY` is missing.                                                           |

## Deferred (unchanged, out of scope for the demo)

ServiceTitan write-back (Phase 12), production KMS (Task 8.2b), the §6.1 launch gates, and the live
webhook/worker/cron services on real data. This job neither needs nor unblocks any of them.
