# Runbook

Operational runbook for the call-insight pipeline. Every failure-model catalog entry
(`src/failure-model/catalog.ts`) carries a stable `runbookRef` of the form
`runbook#<anchor>`; the anchor resolves to a section heading in this file. Sections are
added as their codes are wired into real stages — a missing section means the code
predates this file, not that the pointer is wrong.

No section may contain transcript content or PII; refer to calls by `call_id` only.

## Verbatim PII detected

<!-- anchor: verbatim-pii-detected — runbookRef of VERBATIM_PII_DETECTED (Task 5.2) -->

**Code:** `VERBATIM_PII_DETECTED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call

The extract stage's second PII scan found possible residual PII in a model-extracted
verbatim `customer_language` marketing phrase. The phrase was held/scrubbed, was not
stored in `structured_knowledge`, and will not be exported — but this is a
**post-extraction** hit, so do not assume data is safe: the redacted transcript that
produced the phrase already crossed to Anthropic and may have carried the same value,
and the scan-stage path transiently persisted the phrase in the extraction staging
table (`extraction_candidates`) before scrubbing.

### 1. Was it egressed? (do this first)

1. Open the held call in the review surface by the alert's `call_id`.
2. Load the call's redacted transcript (`clean_transcripts`) — the exact text that was
   sent to Anthropic — and check whether it contains the same value the scan flagged in
   the verbatim phrase.
   - **Yes, the value is in the redacted transcript:** residual PII crossed the privacy
     boundary. This is a redaction recall gap — treat it as a privacy-boundary incident:
     record it in the review notes, and add the value's shape to the deny list and the
     redaction corpus (step 3) before releasing anything.
   - **No, the redacted transcript is clean:** the extractor reconstructed or selected
     risky text (e.g. reassembled spelled-out digits, or quoted a tokenized span in a
     leaky way). No egress occurred, but the extractor prompt needs tightening (step 3).
3. Either way, discard or correct the flagged phrase in review; never store the flagged
   text as-is.

### 2. Resolve the held call

- Correct or drop the verbatim phrase, then approve the record so the rest of the
  extraction is stored; or reject the record entirely if it cannot be salvaged.
- Do not override the hold without completing step 1 — the egress check is the point of
  this alert.

### 3. Close the gap (longer-term fix)

As the review indicates:

- **Deny list:** add the leaked term (or its normalized shape) to the redaction deny
  list so both the primary layers and the residual scan catch it.
- **Redaction corpus:** add an adversarial fixture reproducing the miss to the redaction
  corpus, so recall gating catches a regression of this shape.
- **Extractor prompt:** if the extractor selected or reconstructed risky text from a
  clean transcript, tighten the extraction prompt's verbatim-phrase rules and bump the
  prompt version.

## Config missing or invalid

<!-- anchor: config-missing-or-invalid — CONFIG_MISSING_OR_INVALID -->

**Code:** `CONFIG_MISSING_OR_INVALID` · **Severity:** high · **Calls:** none · **Owner:** platform · **Data safe:** yes

A service cannot start because required configuration is missing or invalid; that
component is down until it is fixed. The config loader names the offending variable.

- **Do now:** Set a valid value for the named environment variable in the failing service and redeploy.
- **Longer-term fix:** Same as the immediate step.

## Database unavailable

<!-- anchor: database-unavailable — DATABASE_UNAVAILABLE -->

**Code:** `DATABASE_UNAVAILABLE` · **Severity:** critical · **Calls:** retried · **Owner:** platform · **Data safe:** yes

Postgres is unreachable; processing is paused and jobs wait in the queue — no calls are lost.

- **Do now:** Check Postgres health, credentials, and network reachability, then restore the connection.
- **Longer-term fix:** Add connection-pool health checks and a failover path if outages recur.

## Redis unavailable

<!-- anchor: redis-unavailable — REDIS_UNAVAILABLE -->

**Code:** `REDIS_UNAVAILABLE` · **Severity:** critical · **Calls:** retried · **Owner:** platform · **Data safe:** yes

Redis (the job queue) is unreachable; events cannot be enqueued or consumed and processing
is paused. The reconciliation cron backfills any missed calls.

- **Do now:** Restore Redis connectivity; verify credentials and memory limits.
- **Longer-term fix:** Add Redis health checks and alert on memory pressure.

## Migration failed

<!-- anchor: migration-failed — MIGRATION_FAILED -->

**Code:** `MIGRATION_FAILED` · **Severity:** high · **Calls:** none · **Owner:** platform · **Data safe:** yes

A database migration failed; the schema may be partially applied and the affected service
will not start.

- **Do now:** Review the migration error, roll back with its down migration, then re-run after fixing.
- **Longer-term fix:** Same as the immediate step.

## Dialpad auth failed

<!-- anchor: dialpad-auth-failed — DIALPAD_AUTH_FAILED -->

**Code:** `DIALPAD_AUTH_FAILED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

Dialpad API authentication failed; transcripts and call lists cannot be fetched — affected
calls are held, not lost.

- **Do now:** Rotate or refresh the Dialpad API credentials and confirm the required scopes.
- **Longer-term fix:** Automate token refresh and alert before credentials expire.

## Dialpad rate limited

<!-- anchor: dialpad-rate-limited — DIALPAD_RATE_LIMITED -->

**Code:** `DIALPAD_RATE_LIMITED` · **Severity:** medium · **Calls:** retried · **Owner:** platform · **Data safe:** yes

Dialpad is rate-limiting requests; transcript fetches are delayed and retried — no calls
are lost.

- **Do now:** Back off and retry within the documented limits; reduce fetch concurrency if it persists.
- **Longer-term fix:** Add adaptive rate limiting and request budgeting for the Dialpad client.

## Dialpad API changed

<!-- anchor: dialpad-api-changed — DIALPAD_API_CHANGED -->

**Code:** `DIALPAD_API_CHANGED` · **Severity:** high · **Calls:** held · **Owner:** platform · **Data safe:** yes

The Dialpad API response shape changed; fetching or parsing is failing and affected calls
are held for review.

- **Do now:** Compare responses against the Dialpad contract, update the client, and reprocess held calls.
- **Longer-term fix:** Add contract tests against Dialpad so shape changes are caught early.

## Dialpad transcript missing

<!-- anchor: dialpad-transcript-missing — DIALPAD_TRANSCRIPT_MISSING -->

**Code:** `DIALPAD_TRANSCRIPT_MISSING` · **Severity:** low · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

A transcript did not become available within the retry window; the call is held for review
rather than guessed or dropped. (A transcript that is merely not-ready-yet is handled by
the availability check and never emits this code.)

- **Do now:** Review the held missing-transcript call and confirm whether Dialpad has the transcript or it should be marked unresolvable.
- **Longer-term fix:** Same as the immediate step.

**You usually do not need to act.** These holds close themselves. Every reconciliation run
asks Dialpad once more about any UNCLAIMED `missing_transcript` hold older than
`TRANSCRIPT_ABANDON_AFTER_MS` (default 24 h) and, if the transcript is still absent, closes
it as `unresolvable` and acknowledges both this alert and the `REVIEW_QUEUE_STALLED` alert it
raised. Assigning the item to yourself, or moving it to `in_review`, opts it OUT of the
auto-close — so claim it only if you intend to work it. `TRANSCRIPT_ABANDON_ENABLED=false`
disables the duty entirely.

**When the SAME agent keeps appearing**, the cause is upstream of this pipeline: Dialpad Ai
never transcribed those calls. Transcription is per-call, not per-licence — an agent whose
calls transcribe most of the time but not always is usually answering some calls on a device
Dialpad Ai cannot listen to (a desk phone, or a cell via call forwarding) rather than in the
Dialpad app. Check that agent's device/answer settings in the Dialpad admin console. To find
the pattern, group recent `missing_transcript` holds by the Dialpad `target.id` of each call:
concentration on one target is the signal.

## Webhook signature invalid

<!-- anchor: webhook-signature-invalid — WEBHOOK_SIGNATURE_INVALID -->

**Code:** `WEBHOOK_SIGNATURE_INVALID` · **Severity:** medium · **Calls:** none · **Owner:** OVIO on-call · **Data safe:** yes

A webhook request failed signature verification and was rejected; nothing was ingested from
it. Legitimate calls are still recovered by the reconciliation cron.

- **Do now:** Confirm the shared signing secret matches Dialpad's, and investigate possible spoofing.
- **Longer-term fix:** Rotate the signing secret and monitor rejection rates.

## Webhook replay detected

<!-- anchor: webhook-replay-detected — WEBHOOK_REPLAY_DETECTED -->

**Code:** `WEBHOOK_REPLAY_DETECTED` · **Severity:** low · **Calls:** none · **Owner:** OVIO on-call · **Data safe:** yes

A replayed webhook was detected and ignored; the original event was already processed, so
there is no duplication.

- **Do now:** No action for a single event; investigate if replay volume is high (a possible attack).
- **Longer-term fix:** Same as the immediate step.

## Redaction recall regression

<!-- anchor: redaction-recall-regression — REDACTION_RECALL_REGRESSION -->

**Code:** `REDACTION_RECALL_REGRESSION` · **Severity:** critical · **Calls:** held · **Owner:** platform · **Data safe:** yes

Redaction corpus recall dropped below threshold; to protect privacy, affected calls are
held and nothing is sent to the model.

- **Do now:** Do not disable redaction. Review the recall regression and the redaction rules before releasing any held call.
- **Longer-term fix:** Expand the adversarial redaction corpus and gate releases on recall.

## Redaction low confidence

<!-- anchor: redaction-low-confidence — REDACTION_LOW_CONFIDENCE -->

**Code:** `REDACTION_LOW_CONFIDENCE` · **Severity:** medium · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

Redaction confidence for a call was too low; it is held (fail-closed) and never sent to the
model.

- **Do now:** Route the held call to human review; do not override the hold.
- **Longer-term fix:** Same as the immediate step.

## Model auth failed

<!-- anchor: model-auth-failed — MODEL_AUTH_FAILED -->

**Code:** `MODEL_AUTH_FAILED` · **Severity:** high · **Calls:** held · **Owner:** platform · **Data safe:** yes

Authentication to the model API failed; classification and extraction are paused and calls
are held, not lost.

- **Do now:** Refresh or rotate the model API key and verify the configured model IDs.
- **Longer-term fix:** Automate key rotation and add pre-expiry alerts.

## Model rate limited

<!-- anchor: model-rate-limited — MODEL_RATE_LIMITED -->

**Code:** `MODEL_RATE_LIMITED` · **Severity:** medium · **Calls:** retried · **Owner:** platform · **Data safe:** yes

The model API is rate-limiting; classification and extraction are delayed and retried — no
calls are lost.

- **Do now:** Back off and retry; lower concurrency if it persists.
- **Longer-term fix:** Add adaptive concurrency and a token budget for model calls.

## Model malformed response

<!-- anchor: model-malformed-response — MODEL_MALFORMED_RESPONSE -->

**Code:** `MODEL_MALFORMED_RESPONSE` · **Severity:** medium · **Calls:** held · **Owner:** platform · **Data safe:** yes

The model returned output that failed the schema-validation gate; the record is held rather
than storing malformed data.

- **Do now:** Inspect the prompt and prompt version and the held record, then reprocess after fixing.
- **Longer-term fix:** Tighten the output schema and add golden-fixture coverage.

## Model cost cap exceeded

<!-- anchor: model-cost-cap-exceeded — MODEL_COST_CAP_EXCEEDED -->

**Code:** `MODEL_COST_CAP_EXCEEDED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

The daily model cost cap was reached; new model calls are paused to prevent overspend and
queued calls wait.

- **Do now:** Review daily cost usage, then raise the cap deliberately or wait for the next window.
- **Longer-term fix:** Add cost forecasting and staged alerts before the cap is hit.

## Model cost warning threshold exceeded

<!-- anchor: model-cost-warning-threshold-exceeded — MODEL_COST_WARNING_THRESHOLD_EXCEEDED -->

**Code:** `MODEL_COST_WARNING_THRESHOLD_EXCEEDED` · **Severity:** medium · **Calls:** none · **Owner:** OVIO on-call · **Data safe:** yes

Estimated daily model spend crossed the warning threshold
(`DAILY_MODEL_COST_CAP_USD * DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO`). This is advisory only:
nothing is held, retried, or dropped, and the pipeline keeps running. It fires **at most once
per UTC day** (including after a same-day acknowledgment) and re-arms at the next UTC day. Its
purpose is lead time before the hard cap (`MODEL_COST_CAP_EXCEEDED`) starts holding calls.

- **Do now:** Review daily cost usage against the cap, then raise the cap deliberately or reduce
  model volume before the hard cap is reached.
- **Longer-term fix:** Add cost forecasting and volume controls so spend is managed before the cap.

## Queue retry exhausted

<!-- anchor: queue-retry-exhausted — QUEUE_RETRY_EXHAUSTED -->

**Code:** `QUEUE_RETRY_EXHAUSTED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

A job exhausted its capped retries and stopped; the affected call is not processed until it
is requeued.

- **Do now:** Inspect the job's failure, fix the root cause, and requeue the call.
- **Longer-term fix:** Tune retry and backoff, and add a dead-letter review workflow.

## Dead letter created

<!-- anchor: dead-letter-created — DEAD_LETTER_CREATED -->

**Code:** `DEAD_LETTER_CREATED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

A job was moved to the dead-letter queue after exhausting retries; that call is parked and
needs manual attention. The dead-letter row carries sanitized root-cause metadata and the
full failure snapshot.

- **Do now:** Triage the dead-letter row's sanitized root cause, then requeue or resolve it.
- **Longer-term fix:** Add dead-letter dashboards and periodic triage.

## Retention purge failed

<!-- anchor: retention-purge-failed — RETENTION_PURGE_FAILED -->

**Code:** `RETENTION_PURGE_FAILED` · **Severity:** high · **Calls:** none · **Owner:** platform · **Data safe:** yes

The retention purge job failed; data past its window may persist longer than intended — a
compliance risk, not data loss.

- **Do now:** Investigate the purge failure and re-run the retention job (with a dry-run first).
- **Longer-term fix:** Add purge-success monitoring and alert on overdue rows.

## Backfill checkpoint failed

<!-- anchor: backfill-checkpoint-failed — BACKFILL_CHECKPOINT_FAILED -->

**Code:** `BACKFILL_CHECKPOINT_FAILED` · **Severity:** medium · **Calls:** retried · **Owner:** platform · **Data safe:** yes

A backfill batch failed to checkpoint; the backfill may stall or repeat from the last good
checkpoint — no data is lost.

- **Do now:** Inspect the backfill run and resume from the last checkpoint.
- **Longer-term fix:** Make checkpoints transactional and resumable.

## Review queue stalled

<!-- anchor: review-queue-stalled — REVIEW_QUEUE_STALLED -->

**Code:** `REVIEW_QUEUE_STALLED` · **Severity:** medium · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

Held calls in the review queue are breaching their SLA; customer follow-up may be delayed.

- **Do now:** Assign reviewers to the oldest held calls and clear the backlog.
- **Longer-term fix:** Add SLA alerting and reviewer capacity planning.

## ServiceTitan auth failed

<!-- anchor: servicetitan-auth-failed — SERVICETITAN_AUTH_FAILED -->

**Code:** `SERVICETITAN_AUTH_FAILED` · **Severity:** high · **Calls:** none · **Owner:** platform · **Data safe:** yes

ServiceTitan authentication failed; job matching and write-back are paused. Call processing
itself is unaffected.

- **Do now:** Refresh ServiceTitan credentials and verify the required scopes.
- **Longer-term fix:** Automate token refresh and alert before credentials expire.

## ServiceTitan match weak

<!-- anchor: servicetitan-match-weak — SERVICETITAN_MATCH_WEAK -->

**Code:** `SERVICETITAN_MATCH_WEAK` · **Severity:** low · **Calls:** held · **Owner:** OVIO on-call · **Data safe:** yes

A ServiceTitan match was too weak to trust; the call is held for review and nothing is
written back rather than guessed.

- **Do now:** Review the held weak-match call manually and confirm or reject it before any write-back.
- **Longer-term fix:** Tune match thresholds and add more match keys.

## ServiceTitan write failed

<!-- anchor: servicetitan-write-failed — SERVICETITAN_WRITE_FAILED -->

**Code:** `SERVICETITAN_WRITE_FAILED` · **Severity:** medium · **Calls:** none · **Owner:** platform · **Data safe:** yes

A ServiceTitan write-back failed; the structured record is safe in our store but not yet
reflected in ServiceTitan.

- **Do now:** Retry the write-back after checking ServiceTitan availability; the write carries an idempotency key.
- **Longer-term fix:** Add write-back retry with backoff and periodic reconciliation.

## Request body too large

<!-- anchor: request-body-too-large — REQUEST_BODY_TOO_LARGE -->

**Code:** `REQUEST_BODY_TOO_LARGE` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A request body exceeded the configured size limit and was rejected before parsing; nothing
was ingested from it.

- **Do now:** No action for a single request; if legitimate large payloads are expected, raise `HTTP_MAX_BODY_BYTES` for that surface.
- **Longer-term fix:** Same as the immediate step.

## Request malformed

<!-- anchor: request-malformed — REQUEST_MALFORMED -->

**Code:** `REQUEST_MALFORMED` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A request body could not be parsed (malformed JSON) and was rejected; nothing was ingested
from it.

- **Do now:** No action for a single request; if a caller keeps sending malformed bodies, share the expected request format.
- **Longer-term fix:** Same as the immediate step.

## Unsupported media type

<!-- anchor: unsupported-media-type — UNSUPPORTED_MEDIA_TYPE -->

**Code:** `UNSUPPORTED_MEDIA_TYPE` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A request used an unsupported content type and was rejected; only the documented content
types are accepted.

- **Do now:** No action for a single request; confirm callers send the documented Content-Type header.
- **Longer-term fix:** Same as the immediate step.

## Rate limit exceeded

<!-- anchor: rate-limit-exceeded — RATE_LIMIT_EXCEEDED -->

**Code:** `RATE_LIMIT_EXCEEDED` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A source exceeded the request-rate limit and is being throttled; its requests are rejected
until the window resets. No data is lost.

- **Do now:** No action for expected bursts; if a legitimate source is being throttled, adjust its rate-limit threshold.
- **Longer-term fix:** Add per-source rate-limit tuning and alert on sustained throttling.

## Auth required

<!-- anchor: auth-required — AUTH_REQUIRED -->

**Code:** `AUTH_REQUIRED` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

An unauthenticated request to an internal surface was refused; no protected data was
exposed.

- **Do now:** Sign in through the configured identity provider; if valid sessions are being rejected, check the OIDC and session configuration.
- **Longer-term fix:** Same as the immediate step.

## Auth forbidden

<!-- anchor: auth-forbidden — AUTH_FORBIDDEN -->

**Code:** `AUTH_FORBIDDEN` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

An authenticated request was refused because the session lacked the required elevated role
(e.g. a base reviewer attempting an elevated raw/vault reveal on the review surface); no
protected data was exposed.

- **Do now:** Grant the reviewer the required elevated role, or confirm the action legitimately needs elevation; if valid elevated sessions are being rejected, check the role configuration (`REVIEW_ELEVATED_ROLE`).
- **Longer-term fix:** Same as the immediate step.

## CSRF token invalid

<!-- anchor: csrf-token-invalid — CSRF_TOKEN_INVALID -->

**Code:** `CSRF_TOKEN_INVALID` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A state-changing internal request was refused because its CSRF token was missing or invalid;
no change was made.

- **Do now:** Reload the surface to obtain a fresh CSRF token and retry; if valid tokens are being rejected, check the session configuration.
- **Longer-term fix:** Same as the immediate step.

## Webhook timestamp invalid

<!-- anchor: webhook-timestamp-invalid — WEBHOOK_TIMESTAMP_INVALID -->

**Code:** `WEBHOOK_TIMESTAMP_INVALID` · **Severity:** low · **Calls:** none · **Owner:** platform · **Data safe:** yes

A webhook was rejected because its timestamp was outside the allowed freshness window (stale
or future); nothing was ingested. Legitimate calls are still recovered by the reconciliation
cron.

- **Do now:** Confirm the sender and server clocks are in sync; investigate if stale-timestamp volume is high (a possible replay attack).
- **Longer-term fix:** Monitor rejection rates and widen the skew window only if a clock-sync issue is confirmed.

## Internal error

<!-- anchor: internal-error — INTERNAL_ERROR -->

**Code:** `INTERNAL_ERROR` · **Severity:** high · **Calls:** none · **Owner:** platform · **Data safe:** yes

An HTTP surface hit an unexpected error and returned a generic failure; the request did not
complete. The error detail is in the logs, never in the response.

- **Do now:** Check the service logs for the correlated request id and address the underlying error.
- **Longer-term fix:** Same as the immediate step.

## Evaluation & labeled-examples corpus (Task 6.3)

**Owner:** OVIO · **Data safe:** yes (evaluation data only — never raw stores, vault, or customer
output)

Reviewed decisions are mined into a PII-free labeled corpus and a weekly accuracy check runs over
it. See `docs/evaluation.md` for the full design.

- **Label capture** runs as a health-gated `runLabelSync` duty on the reconciliation cron (every 15
  min UTC). It is the dependable capture path — a correction is mined into `labeled_examples` within
  minutes, well inside the shortest CLEAN soft-purge window. **Invariant:** the label-sync cadence
  must stay shorter than the CLEAN soft-purge window. A nonzero `SyncSummary.failed` or a throw
  withholds the reconciliation heartbeat (see `## Reconciliation heartbeat missed`-style handling);
  the missed check is the alert that label capture is broken.
- **The weekly accuracy check** — cadence: **weekly, Mon 06:00 UTC** (Railway `evaluation-cron.json`,
  `node dist/services/evaluation-run.js`). Command locally: `npm run eval:run`.
  - **Evidence of a healthy run:** an `evaluation_reports` row with `mode='live'` and
    `status='complete'`, a `model_invocations` row per evaluated example (stage
    `evaluation-classify` / `evaluation-extract`), and the `evaluation run complete` structured log
    line. A complete live run pings `EVALUATION_CHECK_URL`.
  - **A missed `EVALUATION_CHECK_URL` ping** means the weekly run did not complete a live pass
    (disabled, non-live misconfig, cost-capped/killed partial, or a crash). **Do now:** check the
    latest `evaluation_reports` row's `status`/`skip_reason` and the structured log; a fail-fast
    `CONFIG_MISSING_OR_INVALID` naming `EVALUATION_LIVE_MODE` means staging/production is enabled but
    not live — set `EVALUATION_LIVE_MODE=true`. A `cost_capped`/`killed` partial means the daily cost
    cap or a model kill switch tripped; resolve that, then re-run. **Longer-term fix:** confirm
    `EVALUATION_RUN_ENABLED=true`, `EVALUATION_LIVE_MODE=true`, and `EVALUATION_CHECK_URL` are set on
    the evaluation service.

## Key rotation failed

<!-- anchor: key-rotation-failed — KEY_ROTATION_FAILED -->

**Code:** `KEY_ROTATION_FAILED` · **Severity:** critical · **Calls:** none · **Owner:** platform · **Data safe:** yes

A key rotation (Task 8.2) aborted before it finished re-encrypting `raw_transcripts` + `token_vault`
onto the new `key_version` and destroying the old external DEK. Causes: in-flight jobs did not drain
within `KEY_ROTATION_DRAIN_TIMEOUT_MS`, a metadata insert failed (the orphan external DEK is
compensated with `destroyDek`), or the verify predicate still found recoverable old-version
ciphertext. **Data is safe and fully readable — the old DEK is NOT destroyed on this path.**

- **Do now:** Read `key_lifecycle_events` for the failed run's `rotate_failed` row. Confirm the queue
  resumed (`queue.resume()` ran; no lingering maintenance flag) and the worker is consuming again.
  Re-run rotation once the cause is fixed; rotation is crash-resumable and refuses to start while a
  prior run is unfinished. Do NOT run `confirm-destruction` for the old key until re-encryption +
  verify succeed.
- **Longer-term fix:** Alert on any `rotating` version, or a `destroy_requested_at`-set/`destroyed_at`-null
  version past its recovery window (the launch gate's stalled-destruction check).

## Key revocation failed

<!-- anchor: key-revocation-failed — KEY_REVOCATION_FAILED -->

**Code:** `KEY_REVOCATION_FAILED` · **Severity:** critical · **Calls:** none · **Owner:** platform · **Data safe:** yes

An emergency DEK or KEK revocation (Task 8.2) aborted before the external key material was confirmed
unrecoverable (`store.recoverability(...)` still true, or the second verify found recoverable
ciphertext). Rows under the target key may still be readable in the live DB **and in restored
backups** until the shred completes.

- **Do now:** Investigate the `revoke_failed` / `destroy_finalize_failed` event. Re-run
  `confirm-destruction` after the recovery window; verify `recoverability` is `false` for every
  affected DEK (and, for a KEK revocation, every `key_version` under that `kek_version`) before
  declaring the shred complete. Restart every DEK-caching service (worker, review surface) so no
  process still holds a cached unwrapped DEK.
- **Longer-term fix:** Monitor revocation completion off `store.recoverability`, never the DB flag.

## Technician-note run degraded

<!-- anchor: technician-note-run-degraded — TECHNICIAN_NOTE_RUN_DEGRADED -->

**Code:** `TECHNICIAN_NOTE_RUN_DEGRADED` · **Severity:** medium · **Calls:** none · **Owner:** OVIO on-call · **Data safe:** yes

A batch run of the technician-note generator (`npm run notes:generate`, ADR 0009) finished with a
failure rate above `TECHNICIAN_NOTES_FAILURE_RATE_ALERT_THRESHOLD` over at least
`TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS` attempted calls.

**Nothing else is affected.** A technician note is derived and optional: the calls were already
processed, their `structured_knowledge` records are already stored, and this job never holds a call
or writes a `review_queue` row (a hold would block the CLEAN retention purge through `cleanBlocking`
and silently extend PII retention for a cosmetic failure). No note is the correct degraded state,
and a re-run regenerates whatever is missing.

- **Do now:** Re-run `npm run notes:generate`. Failures are counted per call in `processing_log`
  under stage `technician-note` with a counts-only detail (`schema_invalid` vs a model error) — read
  those to tell a prompt/schema drift apart from an Anthropic outage. Check for a companion
  `MODEL_AUTH_FAILED` / `MODEL_RATE_LIMITED` alert before changing anything.
- **Longer-term fix:** If the failures are `schema_invalid`, fix the note prompt or schema, bump
  `TECHNICIAN_NOTE_PROMPT_VERSION`, and regenerate the affected calls with
  `npm run notes:generate -- --regenerate`. Reviewer verdicts are scoped to the prompt version they
  were given against, so a version bump keeps the ADR 0009 feedback loop honest.
