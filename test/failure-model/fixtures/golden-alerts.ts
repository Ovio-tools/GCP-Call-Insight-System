import type { ErrorCode, FormattedAlert } from '../../../src/failure-model/index.js';

/**
 * Committed golden alerts: the output of formatAlert(sampleFailureFor(code), GOLDEN_OPTS) for
 * every code, captured as a snapshot. A change in the formatter (field mapping,
 * SAME_AS_IMMEDIATE rendering, affectedScope order) diverges from these and fails the test.
 * Regenerate deliberately if the formatting contract changes.
 */
export const GOLDEN_ALERTS: Record<ErrorCode, FormattedAlert> = {
  CONFIG_MISSING_OR_INVALID: {
    errorCode: 'CONFIG_MISSING_OR_INVALID',
    severity: 'high',
    whatBroke: 'A service refused to start because its configuration check failed.',
    likelyRootCause:
      "A required setting is missing or has an invalid value in that service's environment.",
    impact:
      'A service cannot start because required configuration is missing or invalid; that component is down until it is fixed.',
    immediateRemediation:
      'Set a valid value for the named environment variable in the failing service and redeploy.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#config-missing-or-invalid',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  DATABASE_UNAVAILABLE: {
    errorCode: 'DATABASE_UNAVAILABLE',
    severity: 'critical',
    whatBroke: 'The system could not reach its main database.',
    likelyRootCause: 'The database is down, unreachable over the network, or refusing credentials.',
    impact:
      'Postgres is unreachable; processing is paused and jobs wait in the queue — no calls are lost.',
    immediateRemediation:
      'Check Postgres health, credentials, and network reachability, then restore the connection.',
    longerTermFix: 'Add connection-pool health checks and a failover path if outages recur.',
    dataSafe: true,
    callsState: 'retried',
    runbookRef: 'runbook#database-unavailable',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  REDIS_UNAVAILABLE: {
    errorCode: 'REDIS_UNAVAILABLE',
    severity: 'critical',
    whatBroke: 'The system could not reach its job queue.',
    likelyRootCause: 'Redis is down, unreachable over the network, or out of memory.',
    impact:
      'Redis (the job queue) is unreachable; events cannot be enqueued or consumed and processing is paused. The reconciliation cron backfills any missed calls.',
    immediateRemediation: 'Restore Redis connectivity; verify credentials and memory limits.',
    longerTermFix: 'Add Redis health checks and alert on memory pressure.',
    dataSafe: true,
    callsState: 'retried',
    runbookRef: 'runbook#redis-unavailable',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MIGRATION_FAILED: {
    errorCode: 'MIGRATION_FAILED',
    severity: 'high',
    whatBroke: 'A database schema update failed partway through.',
    likelyRootCause: 'The migration hit an error or unexpected existing state while applying.',
    impact:
      'A database migration failed; the schema may be partially applied and the affected service will not start.',
    immediateRemediation:
      'Review the migration error, roll back with its down migration, then re-run after fixing.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#migration-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  DIALPAD_AUTH_FAILED: {
    errorCode: 'DIALPAD_AUTH_FAILED',
    severity: 'high',
    whatBroke: 'Dialpad rejected our sign-in when fetching call data.',
    likelyRootCause: 'The Dialpad API key is expired, revoked, or missing a required permission.',
    impact:
      'Dialpad API authentication failed; transcripts and call lists cannot be fetched — affected calls are held, not lost.',
    immediateRemediation:
      'Rotate or refresh the Dialpad API credentials and confirm the required scopes.',
    longerTermFix: 'Automate token refresh and alert before credentials expire.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#dialpad-auth-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  DIALPAD_RATE_LIMITED: {
    errorCode: 'DIALPAD_RATE_LIMITED',
    severity: 'medium',
    whatBroke: 'Dialpad is temporarily refusing our requests because we sent too many.',
    likelyRootCause: "Request volume exceeded Dialpad's rate limits.",
    impact:
      'Dialpad is rate-limiting requests; transcript fetches are delayed and retried — no calls are lost.',
    immediateRemediation:
      'Back off and retry within the documented limits; reduce fetch concurrency if it persists.',
    longerTermFix: 'Add adaptive rate limiting and request budgeting for the Dialpad client.',
    dataSafe: true,
    callsState: 'retried',
    runbookRef: 'runbook#dialpad-rate-limited',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  DIALPAD_API_CHANGED: {
    errorCode: 'DIALPAD_API_CHANGED',
    severity: 'high',
    whatBroke: 'Dialpad answered a request in a format the system did not recognise.',
    likelyRootCause:
      'Dialpad changed its response format, or sent a rare variant our client does not handle yet.',
    impact:
      'The Dialpad API response shape changed; fetching or parsing is failing and affected calls are held for review.',
    immediateRemediation:
      'Compare responses against the Dialpad contract, update the client, and reprocess held calls.',
    longerTermFix: 'Add contract tests against Dialpad so shape changes are caught early.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#dialpad-api-changed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  DIALPAD_TRANSCRIPT_MISSING: {
    errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
    severity: 'low',
    whatBroke: "A call's transcript never became available from Dialpad.",
    likelyRootCause:
      'Dialpad did not produce a transcript for this call within the waiting window.',
    impact:
      'A transcript did not become available within the retry window; the call is held for review rather than guessed or dropped.',
    immediateRemediation:
      'Review the held missing-transcript call and confirm whether Dialpad has the transcript or it should be marked unresolvable.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#dialpad-transcript-missing',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  WEBHOOK_SIGNATURE_INVALID: {
    errorCode: 'WEBHOOK_SIGNATURE_INVALID',
    severity: 'medium',
    whatBroke: 'An incoming webhook failed its authenticity check and was turned away.',
    likelyRootCause: 'A mismatched signing secret, or someone other than Dialpad sending requests.',
    impact:
      'A webhook request failed signature verification and was rejected; nothing was ingested from it. Legitimate calls are still recovered by the reconciliation cron.',
    immediateRemediation:
      "Confirm the shared signing secret matches Dialpad's, and investigate possible spoofing.",
    longerTermFix: 'Rotate the signing secret and monitor rejection rates.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#webhook-signature-invalid',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  WEBHOOK_REPLAY_DETECTED: {
    errorCode: 'WEBHOOK_REPLAY_DETECTED',
    severity: 'low',
    whatBroke: 'An already-processed webhook arrived a second time and was ignored.',
    likelyRootCause: 'A network retry re-delivered the event, or someone replayed it deliberately.',
    impact:
      'A replayed webhook was detected and ignored; the original event was already processed, so there is no duplication.',
    immediateRemediation:
      'No action for a single event; investigate if replay volume is high (a possible attack).',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#webhook-replay-detected',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  REDACTION_RECALL_REGRESSION: {
    errorCode: 'REDACTION_RECALL_REGRESSION',
    severity: 'critical',
    whatBroke:
      'The privacy step that hides personal details started missing more than the allowed amount.',
    likelyRootCause: 'A recent change to the redaction rules or model weakened detection.',
    impact:
      'Redaction corpus recall dropped below threshold; to protect privacy, affected calls are held and nothing is sent to the model.',
    immediateRemediation:
      'Do not disable redaction. Review the recall regression and the redaction rules before releasing any held call.',
    longerTermFix: 'Expand the adversarial redaction corpus and gate releases on recall.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#redaction-recall-regression',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  REDACTION_LOW_CONFIDENCE: {
    errorCode: 'REDACTION_LOW_CONFIDENCE',
    severity: 'medium',
    whatBroke: 'The system was not confident it found every personal detail in a call.',
    likelyRootCause:
      'The transcript contains phrasing the redaction layers could not confidently classify.',
    impact:
      'Redaction confidence for a call was too low; it is held (fail-closed) and never sent to the model.',
    immediateRemediation: 'Route the held call to human review; do not override the hold.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#redaction-low-confidence',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MODEL_AUTH_FAILED: {
    errorCode: 'MODEL_AUTH_FAILED',
    severity: 'high',
    whatBroke: 'The AI service rejected our sign-in.',
    likelyRootCause: 'The model API key is expired, revoked, or misconfigured.',
    impact:
      'Authentication to the model API failed; classification and extraction are paused and calls are held, not lost.',
    immediateRemediation:
      'Refresh or rotate the model API key and verify the configured model IDs.',
    longerTermFix: 'Automate key rotation and add pre-expiry alerts.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#model-auth-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MODEL_RATE_LIMITED: {
    errorCode: 'MODEL_RATE_LIMITED',
    severity: 'medium',
    whatBroke: 'The AI service is temporarily refusing our requests because we sent too many.',
    likelyRootCause: "Request volume exceeded the model provider's rate limits.",
    impact:
      'The model API is rate-limiting; classification and extraction are delayed and retried — no calls are lost.',
    immediateRemediation: 'Back off and retry; lower concurrency if it persists.',
    longerTermFix: 'Add adaptive concurrency and a token budget for model calls.',
    dataSafe: true,
    callsState: 'retried',
    runbookRef: 'runbook#model-rate-limited',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MODEL_MALFORMED_RESPONSE: {
    errorCode: 'MODEL_MALFORMED_RESPONSE',
    severity: 'medium',
    whatBroke: 'The AI returned an answer in the wrong format, so it was not stored.',
    likelyRootCause: 'The model deviated from the required output format for this call.',
    impact:
      'The model returned output that failed the schema-validation gate; the record is held rather than storing malformed data.',
    immediateRemediation:
      'Inspect the prompt and prompt version and the held record, then reprocess after fixing.',
    longerTermFix: 'Tighten the output schema and add golden-fixture coverage.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#model-malformed-response',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MODEL_COST_CAP_EXCEEDED: {
    errorCode: 'MODEL_COST_CAP_EXCEEDED',
    severity: 'high',
    whatBroke: "Today's AI spending limit was reached, so AI steps are paused for the day.",
    likelyRootCause:
      'Higher-than-usual call volume or unusually long calls used up the daily budget.',
    impact:
      'The daily model cost cap was reached; new model calls are paused to prevent overspend and queued calls wait.',
    immediateRemediation:
      'Review daily cost usage, then raise the cap deliberately or wait for the next window.',
    longerTermFix: 'Add cost forecasting and staged alerts before the cap is hit.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#model-cost-cap-exceeded',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  MODEL_COST_WARNING_THRESHOLD_EXCEEDED: {
    errorCode: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
    severity: 'medium',
    whatBroke:
      "Today's AI spending is approaching its daily limit — an advance warning, nothing is paused yet.",
    likelyRootCause: 'Call volume or call length is running higher than usual today.',
    impact:
      'Daily model spend crossed the warning threshold; processing continues, but the daily hard cap is approaching and will start holding calls if spend reaches it.',
    immediateRemediation:
      'Review daily cost usage against the cap, then raise the cap deliberately or reduce model volume before the hard cap is reached.',
    longerTermFix: 'Add cost forecasting and volume controls so spend is managed before the cap.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#model-cost-warning-threshold-exceeded',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  QUEUE_RETRY_EXHAUSTED: {
    errorCode: 'QUEUE_RETRY_EXHAUSTED',
    severity: 'high',
    whatBroke: "A call's processing job kept failing and used up all of its retries.",
    likelyRootCause:
      'A persistent error in one processing step — the stored failure detail names the step and error.',
    impact:
      'A job exhausted its capped retries and stopped; the affected call is not processed until it is requeued.',
    immediateRemediation: "Inspect the job's failure, fix the root cause, and requeue the call.",
    longerTermFix: 'Tune retry and backoff, and add a dead-letter review workflow.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#queue-retry-exhausted',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  DEAD_LETTER_CREATED: {
    errorCode: 'DEAD_LETTER_CREATED',
    severity: 'high',
    whatBroke: 'A call was set aside for manual attention after its job failed every retry.',
    likelyRootCause:
      'A persistent error in one processing step; the parked row records which step and what failed.',
    impact:
      'A job was moved to the dead-letter queue after exhausting retries; that call is parked and needs manual attention.',
    immediateRemediation:
      "Triage the dead-letter row's sanitized root cause, then requeue or resolve it.",
    longerTermFix: 'Add dead-letter dashboards and periodic triage.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#dead-letter-created',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  RETENTION_PURGE_FAILED: {
    errorCode: 'RETENTION_PURGE_FAILED',
    severity: 'high',
    whatBroke: 'The scheduled data-deletion job did not complete.',
    likelyRootCause: 'A database error or lock stopped the purge run.',
    impact:
      'The retention purge job failed; data past its window may persist longer than intended — a compliance risk, not data loss.',
    immediateRemediation:
      'Investigate the purge failure and re-run the retention job (with a dry-run first).',
    longerTermFix: 'Add purge-success monitoring and alert on overdue rows.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#retention-purge-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  BACKFILL_CHECKPOINT_FAILED: {
    errorCode: 'BACKFILL_CHECKPOINT_FAILED',
    severity: 'medium',
    whatBroke: 'A historical-import batch failed to save its progress marker.',
    likelyRootCause: 'A database or queue error interrupted the batch mid-run.',
    impact:
      'A backfill batch failed to checkpoint; the backfill may stall or repeat from the last good checkpoint — no data is lost.',
    immediateRemediation: 'Inspect the backfill run and resume from the last checkpoint.',
    longerTermFix: 'Make checkpoints transactional and resumable.',
    dataSafe: true,
    callsState: 'retried',
    runbookRef: 'runbook#backfill-checkpoint-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  REVIEW_QUEUE_STALLED: {
    errorCode: 'REVIEW_QUEUE_STALLED',
    severity: 'medium',
    whatBroke: 'Held calls have been waiting for human review longer than the agreed time.',
    likelyRootCause: 'No reviewer has picked up the oldest held calls in time.',
    impact:
      'Held calls in the review queue are breaching their SLA; customer follow-up may be delayed.',
    immediateRemediation: 'Assign reviewers to the oldest held calls and clear the backlog.',
    longerTermFix: 'Add SLA alerting and reviewer capacity planning.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#review-queue-stalled',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  SERVICETITAN_AUTH_FAILED: {
    errorCode: 'SERVICETITAN_AUTH_FAILED',
    severity: 'high',
    whatBroke: 'ServiceTitan rejected our sign-in.',
    likelyRootCause:
      'The ServiceTitan credentials are expired, revoked, or missing a required permission.',
    impact:
      'ServiceTitan authentication failed; job matching and write-back are paused. Call processing itself is unaffected.',
    immediateRemediation: 'Refresh ServiceTitan credentials and verify the required scopes.',
    longerTermFix: 'Automate token refresh and alert before credentials expire.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#servicetitan-auth-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  SERVICETITAN_MATCH_WEAK: {
    errorCode: 'SERVICETITAN_MATCH_WEAK',
    severity: 'low',
    whatBroke: 'A call could not be confidently matched to a ServiceTitan job.',
    likelyRootCause:
      'The phone number or name did not line up strongly enough with any ServiceTitan record.',
    impact:
      'A ServiceTitan match was too weak to trust; the call is held for review and nothing is written back rather than guessed.',
    immediateRemediation:
      'Review the held weak-match call manually and confirm or reject it before any write-back.',
    longerTermFix: 'Tune match thresholds and add more match keys.',
    dataSafe: true,
    callsState: 'held',
    runbookRef: 'runbook#servicetitan-match-weak',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  SERVICETITAN_WRITE_FAILED: {
    errorCode: 'SERVICETITAN_WRITE_FAILED',
    severity: 'medium',
    whatBroke: 'Saving a record into ServiceTitan failed.',
    likelyRootCause: 'ServiceTitan was unavailable or rejected the write.',
    impact:
      'A ServiceTitan write-back failed; the structured record is safe in our store but not yet reflected in ServiceTitan.',
    immediateRemediation:
      'Retry the write-back after checking ServiceTitan availability; the write carries an idempotency key.',
    longerTermFix: 'Add write-back retry with backoff and periodic reconciliation.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#servicetitan-write-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  REQUEST_BODY_TOO_LARGE: {
    errorCode: 'REQUEST_BODY_TOO_LARGE',
    severity: 'low',
    whatBroke: 'An incoming request was bigger than allowed and was turned away.',
    likelyRootCause:
      'A caller sent an oversized payload — a misconfigured sender or an abuse attempt.',
    impact:
      'A request body exceeded the configured size limit and was rejected before parsing; nothing was ingested from it.',
    immediateRemediation:
      'No action for a single request; if legitimate large payloads are expected, raise HTTP_MAX_BODY_BYTES for that surface.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#request-body-too-large',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  REQUEST_MALFORMED: {
    errorCode: 'REQUEST_MALFORMED',
    severity: 'low',
    whatBroke: 'An incoming request could not be read and was turned away.',
    likelyRootCause: 'The caller sent a body that is not valid JSON.',
    impact:
      'A request body could not be parsed (malformed JSON) and was rejected; nothing was ingested from it.',
    immediateRemediation:
      'No action for a single request; if a caller keeps sending malformed bodies, share the expected request format.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#request-malformed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  UNSUPPORTED_MEDIA_TYPE: {
    errorCode: 'UNSUPPORTED_MEDIA_TYPE',
    severity: 'low',
    whatBroke: 'An incoming request used a content format we do not accept and was turned away.',
    likelyRootCause: 'The caller sent the wrong Content-Type header.',
    impact:
      'A request used an unsupported content type and was rejected; only the documented content types are accepted.',
    immediateRemediation:
      'No action for a single request; confirm callers send the documented Content-Type header.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#unsupported-media-type',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  RATE_LIMIT_EXCEEDED: {
    errorCode: 'RATE_LIMIT_EXCEEDED',
    severity: 'low',
    whatBroke: 'One caller sent requests faster than allowed and is being slowed down.',
    likelyRootCause: 'A burst from a single source — a misbehaving client or an abuse attempt.',
    impact:
      'A source exceeded the request-rate limit and is being throttled; its requests are rejected until the window resets. No data is lost.',
    immediateRemediation:
      'No action for expected bursts; if a legitimate source is being throttled, adjust its rate-limit threshold.',
    longerTermFix: 'Add per-source rate-limit tuning and alert on sustained throttling.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#rate-limit-exceeded',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  AUTH_REQUIRED: {
    errorCode: 'AUTH_REQUIRED',
    severity: 'low',
    whatBroke: 'A request without a valid login tried to reach an internal page and was refused.',
    likelyRootCause: 'A signed-out visitor, an expired session, or a misconfigured login flow.',
    impact:
      'An unauthenticated request to an internal surface was refused; no protected data was exposed.',
    immediateRemediation:
      'Sign in through the configured identity provider; if valid sessions are being rejected, check the OIDC and session configuration.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#auth-required',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  CSRF_TOKEN_INVALID: {
    errorCode: 'CSRF_TOKEN_INVALID',
    severity: 'low',
    whatBroke: 'A change request from an internal page failed its forgery check and was refused.',
    likelyRootCause: 'A stale page or expired token — or a forged cross-site request.',
    impact:
      'A state-changing internal request was refused because its CSRF token was missing or invalid; no change was made.',
    immediateRemediation:
      'Reload the surface to obtain a fresh CSRF token and retry; if valid tokens are being rejected, check the session configuration.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#csrf-token-invalid',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  WEBHOOK_TIMESTAMP_INVALID: {
    errorCode: 'WEBHOOK_TIMESTAMP_INVALID',
    severity: 'low',
    whatBroke: 'An incoming webhook was dated too far in the past or future and was turned away.',
    likelyRootCause: 'Clock drift at the sender, a late delivery, or a replayed request.',
    impact:
      'A webhook was rejected because its timestamp was outside the allowed freshness window (stale or future); nothing was ingested. Legitimate calls are still recovered by the reconciliation cron.',
    immediateRemediation:
      'Confirm the sender and server clocks are in sync; investigate if stale-timestamp volume is high (a possible replay attack).',
    longerTermFix:
      'Monitor rejection rates and widen the skew window only if a clock-sync issue is confirmed.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#webhook-timestamp-invalid',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  INTERNAL_ERROR: {
    errorCode: 'INTERNAL_ERROR',
    severity: 'high',
    whatBroke: 'A web request hit an unexpected error and could not be completed.',
    likelyRootCause: 'An unhandled error inside the service — the logs carry the detail.',
    impact:
      'An HTTP surface hit an unexpected error and returned a generic failure; the request did not complete. The error detail is in the logs, never in the response.',
    immediateRemediation:
      'Check the service logs for the correlated request id and address the underlying error.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#internal-error',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  AUTH_FORBIDDEN: {
    errorCode: 'AUTH_FORBIDDEN',
    severity: 'low',
    whatBroke: 'A signed-in user tried an action their role does not allow and was refused.',
    likelyRootCause: 'The session lacks the elevated role this action requires.',
    impact:
      'An authenticated request was refused because the session lacked the required elevated role; no protected data was exposed.',
    immediateRemediation:
      'Grant the reviewer the required elevated role, or confirm the action legitimately needs elevation; if valid elevated sessions are being rejected, check the role configuration.',
    longerTermFix: 'Same as the immediate step.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#auth-forbidden',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  VERBATIM_PII_DETECTED: {
    errorCode: 'VERBATIM_PII_DETECTED',
    severity: 'high',
    whatBroke:
      'A personal detail may have slipped into a quote the AI pulled from a call; the quote was stopped before being stored.',
    likelyRootCause:
      'The earlier privacy step likely missed the detail, or the AI chose a risky quote.',
    impact:
      'Possible residual PII was detected in an extracted verbatim marketing phrase; the phrase is held and scrubbed rather than stored in structured_knowledge or exported, and the call needs review — likely a redaction recall gap or the extractor selecting risky text.',
    immediateRemediation:
      'Review the held call, discard or correct the flagged phrase, and check whether the redacted transcript sent to Anthropic contained the same value.',
    longerTermFix:
      'Update the deny list, the redaction corpus, or the extractor prompt as the review indicates.',
    dataSafe: false,
    callsState: 'held',
    runbookRef: 'runbook#verbatim-pii-detected',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['call_id', 'environment'],
  },
  KEY_ROTATION_FAILED: {
    errorCode: 'KEY_ROTATION_FAILED',
    severity: 'critical',
    whatBroke: 'A scheduled encryption-key change stopped partway through.',
    likelyRootCause:
      'An error during re-encryption or key storage aborted the rotation before it finished.',
    impact:
      'A key rotation aborted before old ciphertext was re-encrypted and the old key destroyed. Data is safe and readable; the crypto-shred promise for the old key is not yet met.',
    immediateRemediation:
      'Check key_lifecycle_events for the failed run, confirm the queue resumed, and re-run rotation (dry-run/verify first). Do NOT destroy the old key until re-encryption + verify succeed.',
    longerTermFix:
      'Add rotation-success monitoring and alert on any rotating/pending-destroy version older than its expected window.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#key-rotation-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
  KEY_REVOCATION_FAILED: {
    errorCode: 'KEY_REVOCATION_FAILED',
    severity: 'critical',
    whatBroke: 'An emergency destruction of an encryption key did not complete.',
    likelyRootCause: 'The key store could not confirm the old key material is unrecoverable.',
    impact:
      'An emergency DEK/KEK revocation aborted before the external material was confirmed unrecoverable. Rows under the target key may still be readable in the live DB and in backups.',
    immediateRemediation:
      'Investigate the revocation failure, re-run the finalizer (confirm-destruction), and verify recoverability is false for every affected version before declaring the shred complete.',
    longerTermFix:
      'Add revocation-completion monitoring keyed off store.recoverability, not the DB flag.',
    dataSafe: true,
    callsState: 'none',
    runbookRef: 'runbook#key-revocation-failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    environment: 'staging',
    affectedScope: ['component', 'environment'],
  },
};
