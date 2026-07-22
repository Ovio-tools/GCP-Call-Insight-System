import {
  type CallsState,
  type ErrorCode,
  type RootCauseCategory,
  ERROR_CODES,
} from './categories.js';

/**
 * The static remediation catalog: the single source of truth for the §4 fields that
 * are inherent to an error code (impact, remediation, data-safety, calls-state, owner,
 * runbook). Situational fields (`severity` override, `processing_state`, `context`) are
 * NOT here — they are supplied per occurrence.
 *
 * There is deliberately NO generic `UNKNOWN` fallback entry: `catalogFor` throws on an
 * unknown code, so every failure must be a named, deliberately-documented member.
 */

/** The explicit value for a longer-term fix that is the same as the immediate step. */
export const SAME_AS_IMMEDIATE = 'same as immediate' as const;

export interface CatalogEntry {
  /** The root-cause category this code maps to (currently 1:1 with the code). */
  readonly rootCauseCategory: RootCauseCategory;
  /**
   * One plain-language sentence: what observable thing broke. Written for a non-technical
   * reader — never the raw error code (that stays in the alert header for correlation).
   */
  readonly whatBroke: string;
  /** One plain-language sentence: the likely reason it broke. Never the raw code. */
  readonly likelyCause: string;
  /** Human-readable business/customer impact. No jargon. Never empty. */
  readonly impact: string;
  /** The immediate step to take. Never empty. */
  readonly remediationNow: string;
  /** The longer-term fix, or `SAME_AS_IMMEDIATE` when it is the same as the immediate step. */
  readonly remediationFix: string;
  /** Whether customer data is safe (never leaked/lost/corrupted). */
  readonly dataSafe: boolean;
  /** Whether affected calls are held, retried, dropped, or there are none in flight. */
  readonly callsState: CallsState;
  /** Who is paged / who acts. */
  readonly owner: string;
  /** Stable pointer into the runbook. */
  readonly runbookRef: string;
}

const OVIO = 'OVIO on-call';
const PLATFORM = 'platform';

export const REMEDIATION_CATALOG: Record<ErrorCode, CatalogEntry> = {
  CONFIG_MISSING_OR_INVALID: {
    rootCauseCategory: 'CONFIG_MISSING_OR_INVALID',
    whatBroke: 'A service refused to start because its configuration check failed.',
    likelyCause:
      "A required setting is missing or has an invalid value in that service's environment.",
    impact:
      'A service cannot start because required configuration is missing or invalid; that component is down until it is fixed.',
    remediationNow:
      'Set a valid value for the named environment variable in the failing service and redeploy.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#config-missing-or-invalid',
  },
  DATABASE_UNAVAILABLE: {
    rootCauseCategory: 'DATABASE_UNAVAILABLE',
    whatBroke: 'The system could not reach its main database.',
    likelyCause: 'The database is down, unreachable over the network, or refusing credentials.',
    impact:
      'Postgres is unreachable; processing is paused and jobs wait in the queue — no calls are lost.',
    remediationNow:
      'Check Postgres health, credentials, and network reachability, then restore the connection.',
    remediationFix: 'Add connection-pool health checks and a failover path if outages recur.',
    dataSafe: true,
    callsState: 'retried',
    owner: PLATFORM,
    runbookRef: 'runbook#database-unavailable',
  },
  REDIS_UNAVAILABLE: {
    rootCauseCategory: 'REDIS_UNAVAILABLE',
    whatBroke: 'The system could not reach its job queue.',
    likelyCause: 'Redis is down, unreachable over the network, or out of memory.',
    impact:
      'Redis (the job queue) is unreachable; events cannot be enqueued or consumed and processing is paused. The reconciliation cron backfills any missed calls.',
    remediationNow: 'Restore Redis connectivity; verify credentials and memory limits.',
    remediationFix: 'Add Redis health checks and alert on memory pressure.',
    dataSafe: true,
    callsState: 'retried',
    owner: PLATFORM,
    runbookRef: 'runbook#redis-unavailable',
  },
  MIGRATION_FAILED: {
    rootCauseCategory: 'MIGRATION_FAILED',
    whatBroke: 'A database schema update failed partway through.',
    likelyCause: 'The migration hit an error or unexpected existing state while applying.',
    impact:
      'A database migration failed; the schema may be partially applied and the affected service will not start.',
    remediationNow:
      'Review the migration error, roll back with its down migration, then re-run after fixing.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#migration-failed',
  },
  DIALPAD_AUTH_FAILED: {
    rootCauseCategory: 'DIALPAD_AUTH_FAILED',
    whatBroke: 'Dialpad rejected our sign-in when fetching call data.',
    likelyCause: 'The Dialpad API key is expired, revoked, or missing a required permission.',
    impact:
      'Dialpad API authentication failed; transcripts and call lists cannot be fetched — affected calls are held, not lost.',
    remediationNow:
      'Rotate or refresh the Dialpad API credentials and confirm the required scopes.',
    remediationFix: 'Automate token refresh and alert before credentials expire.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#dialpad-auth-failed',
  },
  DIALPAD_RATE_LIMITED: {
    rootCauseCategory: 'DIALPAD_RATE_LIMITED',
    whatBroke: 'Dialpad is temporarily refusing our requests because we sent too many.',
    likelyCause: "Request volume exceeded Dialpad's rate limits.",
    impact:
      'Dialpad is rate-limiting requests; transcript fetches are delayed and retried — no calls are lost.',
    remediationNow:
      'Back off and retry within the documented limits; reduce fetch concurrency if it persists.',
    remediationFix: 'Add adaptive rate limiting and request budgeting for the Dialpad client.',
    dataSafe: true,
    callsState: 'retried',
    owner: PLATFORM,
    runbookRef: 'runbook#dialpad-rate-limited',
  },
  DIALPAD_API_CHANGED: {
    rootCauseCategory: 'DIALPAD_API_CHANGED',
    whatBroke: 'Dialpad answered a request in a format the system did not recognise.',
    likelyCause:
      'Dialpad changed its response format, or sent a rare variant our client does not handle yet.',
    impact:
      'The Dialpad API response shape changed; fetching or parsing is failing and affected calls are held for review.',
    remediationNow:
      'Compare responses against the Dialpad contract, update the client, and reprocess held calls.',
    remediationFix: 'Add contract tests against Dialpad so shape changes are caught early.',
    dataSafe: true,
    callsState: 'held',
    owner: PLATFORM,
    runbookRef: 'runbook#dialpad-api-changed',
  },
  DIALPAD_TRANSCRIPT_MISSING: {
    rootCauseCategory: 'DIALPAD_TRANSCRIPT_MISSING',
    whatBroke: "A call's transcript never became available from Dialpad.",
    likelyCause: 'Dialpad did not produce a transcript for this call within the waiting window.',
    // The transient "not yet ready" state is handled by the availability check and never
    // emits this code; DIALPAD_TRANSCRIPT_MISSING fires only when the transcript never
    // arrives within the window and the call is held with reason `missing_transcript` (§3.2).
    impact:
      'A transcript did not become available within the retry window; the call is held for review rather than guessed or dropped.',
    remediationNow:
      'Review the held missing-transcript call and confirm whether Dialpad has the transcript or it should be marked unresolvable.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#dialpad-transcript-missing',
  },
  WEBHOOK_SIGNATURE_INVALID: {
    rootCauseCategory: 'WEBHOOK_SIGNATURE_INVALID',
    whatBroke: 'An incoming webhook failed its authenticity check and was turned away.',
    likelyCause: 'A mismatched signing secret, or someone other than Dialpad sending requests.',
    impact:
      'A webhook request failed signature verification and was rejected; nothing was ingested from it. Legitimate calls are still recovered by the reconciliation cron.',
    remediationNow:
      "Confirm the shared signing secret matches Dialpad's, and investigate possible spoofing.",
    remediationFix: 'Rotate the signing secret and monitor rejection rates.',
    dataSafe: true,
    callsState: 'none',
    owner: OVIO,
    runbookRef: 'runbook#webhook-signature-invalid',
  },
  WEBHOOK_REPLAY_DETECTED: {
    rootCauseCategory: 'WEBHOOK_REPLAY_DETECTED',
    whatBroke: 'An already-processed webhook arrived a second time and was ignored.',
    likelyCause: 'A network retry re-delivered the event, or someone replayed it deliberately.',
    impact:
      'A replayed webhook was detected and ignored; the original event was already processed, so there is no duplication.',
    remediationNow:
      'No action for a single event; investigate if replay volume is high (a possible attack).',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: OVIO,
    runbookRef: 'runbook#webhook-replay-detected',
  },
  REDACTION_RECALL_REGRESSION: {
    rootCauseCategory: 'REDACTION_RECALL_REGRESSION',
    whatBroke:
      'The privacy step that hides personal details started missing more than the allowed amount.',
    likelyCause: 'A recent change to the redaction rules or model weakened detection.',
    impact:
      'Redaction corpus recall dropped below threshold; to protect privacy, affected calls are held and nothing is sent to the model.',
    remediationNow:
      'Do not disable redaction. Review the recall regression and the redaction rules before releasing any held call.',
    remediationFix: 'Expand the adversarial redaction corpus and gate releases on recall.',
    dataSafe: true,
    callsState: 'held',
    owner: PLATFORM,
    runbookRef: 'runbook#redaction-recall-regression',
  },
  REDACTION_LOW_CONFIDENCE: {
    rootCauseCategory: 'REDACTION_LOW_CONFIDENCE',
    whatBroke: 'The system was not confident it found every personal detail in a call.',
    likelyCause:
      'The transcript contains phrasing the redaction layers could not confidently classify.',
    impact:
      'Redaction confidence for a call was too low; it is held (fail-closed) and never sent to the model.',
    remediationNow: 'Route the held call to human review; do not override the hold.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#redaction-low-confidence',
  },
  MODEL_AUTH_FAILED: {
    rootCauseCategory: 'MODEL_AUTH_FAILED',
    whatBroke: 'The AI service rejected our sign-in.',
    likelyCause: 'The model API key is expired, revoked, or misconfigured.',
    impact:
      'Authentication to the model API failed; classification and extraction are paused and calls are held, not lost.',
    remediationNow: 'Refresh or rotate the model API key and verify the configured model IDs.',
    remediationFix: 'Automate key rotation and add pre-expiry alerts.',
    dataSafe: true,
    callsState: 'held',
    owner: PLATFORM,
    runbookRef: 'runbook#model-auth-failed',
  },
  MODEL_RATE_LIMITED: {
    rootCauseCategory: 'MODEL_RATE_LIMITED',
    whatBroke: 'The AI service is temporarily refusing our requests because we sent too many.',
    likelyCause: "Request volume exceeded the model provider's rate limits.",
    impact:
      'The model API is rate-limiting; classification and extraction are delayed and retried — no calls are lost.',
    remediationNow: 'Back off and retry; lower concurrency if it persists.',
    remediationFix: 'Add adaptive concurrency and a token budget for model calls.',
    dataSafe: true,
    callsState: 'retried',
    owner: PLATFORM,
    runbookRef: 'runbook#model-rate-limited',
  },
  MODEL_MALFORMED_RESPONSE: {
    rootCauseCategory: 'MODEL_MALFORMED_RESPONSE',
    whatBroke: 'The AI returned an answer in the wrong format, so it was not stored.',
    likelyCause: 'The model deviated from the required output format for this call.',
    impact:
      'The model returned output that failed the schema-validation gate; the record is held rather than storing malformed data.',
    remediationNow:
      'Inspect the prompt and prompt version and the held record, then reprocess after fixing.',
    remediationFix: 'Tighten the output schema and add golden-fixture coverage.',
    dataSafe: true,
    callsState: 'held',
    owner: PLATFORM,
    runbookRef: 'runbook#model-malformed-response',
  },
  MODEL_COST_CAP_EXCEEDED: {
    rootCauseCategory: 'MODEL_COST_CAP_EXCEEDED',
    whatBroke: "Today's AI spending limit was reached, so AI steps are paused for the day.",
    likelyCause: 'Higher-than-usual call volume or unusually long calls used up the daily budget.',
    impact:
      'The daily model cost cap was reached; new model calls are paused to prevent overspend and queued calls wait.',
    remediationNow:
      'Review daily cost usage, then raise the cap deliberately or wait for the next window.',
    remediationFix: 'Add cost forecasting and staged alerts before the cap is hit.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#model-cost-cap-exceeded',
  },
  MODEL_COST_WARNING_THRESHOLD_EXCEEDED: {
    rootCauseCategory: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
    whatBroke:
      "Today's AI spending is approaching its daily limit — an advance warning, nothing is paused yet.",
    likelyCause: 'Call volume or call length is running higher than usual today.',
    // Advisory only (Task 7.2): callsState is 'none' — nothing is held, retried, or dropped, and
    // processing continues. Emitted at most once per UTC day as estimated spend approaches the
    // hard cap, so an operator can act before MODEL_COST_CAP_EXCEEDED starts holding calls.
    impact:
      'Daily model spend crossed the warning threshold; processing continues, but the daily hard cap is approaching and will start holding calls if spend reaches it.',
    remediationNow:
      'Review daily cost usage against the cap, then raise the cap deliberately or reduce model volume before the hard cap is reached.',
    remediationFix: 'Add cost forecasting and volume controls so spend is managed before the cap.',
    dataSafe: true,
    callsState: 'none',
    owner: OVIO,
    runbookRef: 'runbook#model-cost-warning-threshold-exceeded',
  },
  QUEUE_RETRY_EXHAUSTED: {
    rootCauseCategory: 'QUEUE_RETRY_EXHAUSTED',
    whatBroke: "A call's processing job kept failing and used up all of its retries.",
    likelyCause:
      'A persistent error in one processing step — the stored failure detail names the step and error.',
    impact:
      'A job exhausted its capped retries and stopped; the affected call is not processed until it is requeued.',
    remediationNow: "Inspect the job's failure, fix the root cause, and requeue the call.",
    remediationFix: 'Tune retry and backoff, and add a dead-letter review workflow.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#queue-retry-exhausted',
  },
  DEAD_LETTER_CREATED: {
    rootCauseCategory: 'DEAD_LETTER_CREATED',
    whatBroke: 'A call was set aside for manual attention after its job failed every retry.',
    likelyCause:
      'A persistent error in one processing step; the parked row records which step and what failed.',
    impact:
      'A job was moved to the dead-letter queue after exhausting retries; that call is parked and needs manual attention.',
    remediationNow:
      "Triage the dead-letter row's sanitized root cause, then requeue or resolve it.",
    remediationFix: 'Add dead-letter dashboards and periodic triage.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#dead-letter-created',
  },
  RETENTION_PURGE_FAILED: {
    rootCauseCategory: 'RETENTION_PURGE_FAILED',
    whatBroke: 'The scheduled data-deletion job did not complete.',
    likelyCause: 'A database error or lock stopped the purge run.',
    impact:
      'The retention purge job failed; data past its window may persist longer than intended — a compliance risk, not data loss.',
    remediationNow:
      'Investigate the purge failure and re-run the retention job (with a dry-run first).',
    remediationFix: 'Add purge-success monitoring and alert on overdue rows.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#retention-purge-failed',
  },
  KEY_ROTATION_FAILED: {
    rootCauseCategory: 'KEY_ROTATION_FAILED',
    whatBroke: 'A scheduled encryption-key change stopped partway through.',
    likelyCause:
      'An error during re-encryption or key storage aborted the rotation before it finished.',
    impact:
      'A key rotation aborted before old ciphertext was re-encrypted and the old key destroyed. Data is safe and readable; the crypto-shred promise for the old key is not yet met.',
    remediationNow:
      'Check key_lifecycle_events for the failed run, confirm the queue resumed, and re-run rotation (dry-run/verify first). Do NOT destroy the old key until re-encryption + verify succeed.',
    remediationFix:
      'Add rotation-success monitoring and alert on any rotating/pending-destroy version older than its expected window.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#key-rotation-failed',
  },
  KEY_REVOCATION_FAILED: {
    rootCauseCategory: 'KEY_REVOCATION_FAILED',
    whatBroke: 'An emergency destruction of an encryption key did not complete.',
    likelyCause: 'The key store could not confirm the old key material is unrecoverable.',
    impact:
      'An emergency DEK/KEK revocation aborted before the external material was confirmed unrecoverable. Rows under the target key may still be readable in the live DB and in backups.',
    remediationNow:
      'Investigate the revocation failure, re-run the finalizer (confirm-destruction), and verify recoverability is false for every affected version before declaring the shred complete.',
    remediationFix:
      'Add revocation-completion monitoring keyed off store.recoverability, not the DB flag.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#key-revocation-failed',
  },
  BACKFILL_CHECKPOINT_FAILED: {
    rootCauseCategory: 'BACKFILL_CHECKPOINT_FAILED',
    whatBroke: 'A historical-import batch failed to save its progress marker.',
    likelyCause: 'A database or queue error interrupted the batch mid-run.',
    impact:
      'A backfill batch failed to checkpoint; the backfill may stall or repeat from the last good checkpoint — no data is lost.',
    remediationNow: 'Inspect the backfill run and resume from the last checkpoint.',
    remediationFix: 'Make checkpoints transactional and resumable.',
    dataSafe: true,
    callsState: 'retried',
    owner: PLATFORM,
    runbookRef: 'runbook#backfill-checkpoint-failed',
  },
  REVIEW_QUEUE_STALLED: {
    rootCauseCategory: 'REVIEW_QUEUE_STALLED',
    whatBroke: 'Held calls have been waiting for human review longer than the agreed time.',
    likelyCause: 'No reviewer has picked up the oldest held calls in time.',
    impact:
      'Held calls in the review queue are breaching their SLA; customer follow-up may be delayed.',
    remediationNow: 'Assign reviewers to the oldest held calls and clear the backlog.',
    remediationFix: 'Add SLA alerting and reviewer capacity planning.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#review-queue-stalled',
  },
  SERVICETITAN_AUTH_FAILED: {
    rootCauseCategory: 'SERVICETITAN_AUTH_FAILED',
    whatBroke: 'ServiceTitan rejected our sign-in.',
    likelyCause:
      'The ServiceTitan credentials are expired, revoked, or missing a required permission.',
    impact:
      'ServiceTitan authentication failed; job matching and write-back are paused. Call processing itself is unaffected.',
    remediationNow: 'Refresh ServiceTitan credentials and verify the required scopes.',
    remediationFix: 'Automate token refresh and alert before credentials expire.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#servicetitan-auth-failed',
  },
  SERVICETITAN_MATCH_WEAK: {
    rootCauseCategory: 'SERVICETITAN_MATCH_WEAK',
    whatBroke: 'A call could not be confidently matched to a ServiceTitan job.',
    likelyCause:
      'The phone number or name did not line up strongly enough with any ServiceTitan record.',
    // A weak match holds with reason `weak_servicetitan_match` and writes nothing (§12.1).
    impact:
      'A ServiceTitan match was too weak to trust; the call is held for review and nothing is written back rather than guessed.',
    remediationNow:
      'Review the held weak-match call manually and confirm or reject it before any write-back.',
    remediationFix: 'Tune match thresholds and add more match keys.',
    dataSafe: true,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#servicetitan-match-weak',
  },
  SERVICETITAN_WRITE_FAILED: {
    rootCauseCategory: 'SERVICETITAN_WRITE_FAILED',
    whatBroke: 'Saving a record into ServiceTitan failed.',
    likelyCause: 'ServiceTitan was unavailable or rejected the write.',
    impact:
      'A ServiceTitan write-back failed; the structured record is safe in our store but not yet reflected in ServiceTitan.',
    remediationNow:
      'Retry the write-back after checking ServiceTitan availability; the write carries an idempotency key.',
    remediationFix: 'Add write-back retry with backoff and periodic reconciliation.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#servicetitan-write-failed',
  },

  // --- HTTP hardening & auth middleware (Task 2.3) ---
  // These are raised by the shared middleware. The impact text is written for an operator
  // reading an alert; the HTTP response itself carries only a terse, PII-free message.
  REQUEST_BODY_TOO_LARGE: {
    rootCauseCategory: 'REQUEST_BODY_TOO_LARGE',
    whatBroke: 'An incoming request was bigger than allowed and was turned away.',
    likelyCause: 'A caller sent an oversized payload — a misconfigured sender or an abuse attempt.',
    impact:
      'A request body exceeded the configured size limit and was rejected before parsing; nothing was ingested from it.',
    remediationNow:
      'No action for a single request; if legitimate large payloads are expected, raise HTTP_MAX_BODY_BYTES for that surface.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#request-body-too-large',
  },
  REQUEST_MALFORMED: {
    rootCauseCategory: 'REQUEST_MALFORMED',
    whatBroke: 'An incoming request could not be read and was turned away.',
    likelyCause: 'The caller sent a body that is not valid JSON.',
    impact:
      'A request body could not be parsed (malformed JSON) and was rejected; nothing was ingested from it.',
    remediationNow:
      'No action for a single request; if a caller keeps sending malformed bodies, share the expected request format.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#request-malformed',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    rootCauseCategory: 'UNSUPPORTED_MEDIA_TYPE',
    whatBroke: 'An incoming request used a content format we do not accept and was turned away.',
    likelyCause: 'The caller sent the wrong Content-Type header.',
    impact:
      'A request used an unsupported content type and was rejected; only the documented content types are accepted.',
    remediationNow:
      'No action for a single request; confirm callers send the documented Content-Type header.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#unsupported-media-type',
  },
  RATE_LIMIT_EXCEEDED: {
    rootCauseCategory: 'RATE_LIMIT_EXCEEDED',
    whatBroke: 'One caller sent requests faster than allowed and is being slowed down.',
    likelyCause: 'A burst from a single source — a misbehaving client or an abuse attempt.',
    impact:
      'A source exceeded the request-rate limit and is being throttled; its requests are rejected until the window resets. No data is lost.',
    remediationNow:
      'No action for expected bursts; if a legitimate source is being throttled, adjust its rate-limit threshold.',
    remediationFix: 'Add per-source rate-limit tuning and alert on sustained throttling.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#rate-limit-exceeded',
  },
  AUTH_REQUIRED: {
    rootCauseCategory: 'AUTH_REQUIRED',
    whatBroke: 'A request without a valid login tried to reach an internal page and was refused.',
    likelyCause: 'A signed-out visitor, an expired session, or a misconfigured login flow.',
    impact:
      'An unauthenticated request to an internal surface was refused; no protected data was exposed.',
    remediationNow:
      'Sign in through the configured identity provider; if valid sessions are being rejected, check the OIDC and session configuration.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#auth-required',
  },
  AUTH_FORBIDDEN: {
    rootCauseCategory: 'AUTH_FORBIDDEN',
    whatBroke: 'A signed-in user tried an action their role does not allow and was refused.',
    likelyCause: 'The session lacks the elevated role this action requires.',
    impact:
      'An authenticated request was refused because the session lacked the required elevated role; no protected data was exposed.',
    remediationNow:
      'Grant the reviewer the required elevated role, or confirm the action legitimately needs elevation; if valid elevated sessions are being rejected, check the role configuration.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#auth-forbidden',
  },
  CSRF_TOKEN_INVALID: {
    rootCauseCategory: 'CSRF_TOKEN_INVALID',
    whatBroke: 'A change request from an internal page failed its forgery check and was refused.',
    likelyCause: 'A stale page or expired token — or a forged cross-site request.',
    impact:
      'A state-changing internal request was refused because its CSRF token was missing or invalid; no change was made.',
    remediationNow:
      'Reload the surface to obtain a fresh CSRF token and retry; if valid tokens are being rejected, check the session configuration.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#csrf-token-invalid',
  },
  WEBHOOK_TIMESTAMP_INVALID: {
    rootCauseCategory: 'WEBHOOK_TIMESTAMP_INVALID',
    whatBroke: 'An incoming webhook was dated too far in the past or future and was turned away.',
    likelyCause: 'Clock drift at the sender, a late delivery, or a replayed request.',
    impact:
      'A webhook was rejected because its timestamp was outside the allowed freshness window (stale or future); nothing was ingested. Legitimate calls are still recovered by the reconciliation cron.',
    remediationNow:
      'Confirm the sender and server clocks are in sync; investigate if stale-timestamp volume is high (a possible replay attack).',
    remediationFix:
      'Monitor rejection rates and widen the skew window only if a clock-sync issue is confirmed.',
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#webhook-timestamp-invalid',
  },
  INTERNAL_ERROR: {
    rootCauseCategory: 'INTERNAL_ERROR',
    whatBroke: 'A web request hit an unexpected error and could not be completed.',
    likelyCause: 'An unhandled error inside the service — the logs carry the detail.',
    impact:
      'An HTTP surface hit an unexpected error and returned a generic failure; the request did not complete. The error detail is in the logs, never in the response.',
    remediationNow:
      'Check the service logs for the correlated request id and address the underlying error.',
    remediationFix: SAME_AS_IMMEDIATE,
    dataSafe: true,
    callsState: 'none',
    owner: PLATFORM,
    runbookRef: 'runbook#internal-error',
  },

  // --- Extract stage (Task 5.2) ---
  VERBATIM_PII_DETECTED: {
    rootCauseCategory: 'VERBATIM_PII_DETECTED',
    whatBroke:
      'A personal detail may have slipped into a quote the AI pulled from a call; the quote was stopped before being stored.',
    likelyCause:
      'The earlier privacy step likely missed the detail, or the AI chose a risky quote.',
    // dataSafe is deliberately FALSE — do not soften this. This is a POST-extraction hit:
    // the redacted transcript already crossed to Anthropic and may have carried the same
    // value (a redaction recall gap, or the extractor selected risky text), and the
    // scan-stage path transiently persisted the phrase in the extraction staging table
    // (`extraction_candidates`) before scrubbing. The wording must never claim nothing
    // was stored or that data is definitely safe.
    impact:
      'Possible residual PII was detected in an extracted verbatim marketing phrase; the phrase is held and scrubbed rather than stored in structured_knowledge or exported, and the call needs review — likely a redaction recall gap or the extractor selecting risky text.',
    remediationNow:
      'Review the held call, discard or correct the flagged phrase, and check whether the redacted transcript sent to Anthropic contained the same value.',
    remediationFix:
      'Update the deny list, the redaction corpus, or the extractor prompt as the review indicates.',
    dataSafe: false,
    callsState: 'held',
    owner: OVIO,
    runbookRef: 'runbook#verbatim-pii-detected',
  },
};

/**
 * The catalog entry for a code. Throws on an unknown code — there is no generic
 * `UNKNOWN` fallback, so every failure must be a named taxonomy member.
 */
export function catalogFor(code: ErrorCode): CatalogEntry {
  const entry = REMEDIATION_CATALOG[code];
  if (!entry || !(ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`No remediation-catalog entry for error code: ${String(code)}`);
  }
  return entry;
}
