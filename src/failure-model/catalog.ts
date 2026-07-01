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
  QUEUE_RETRY_EXHAUSTED: {
    rootCauseCategory: 'QUEUE_RETRY_EXHAUSTED',
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
  BACKFILL_CHECKPOINT_FAILED: {
    rootCauseCategory: 'BACKFILL_CHECKPOINT_FAILED',
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
