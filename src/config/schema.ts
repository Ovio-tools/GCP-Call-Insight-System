import { z } from 'zod';

/** True iff `v` is canonical base64 that decodes to at least `minBytes` bytes.
 * Node's base64 decoder is lenient (silently drops invalid chars), so validity is
 * checked structurally before measuring the decoded length. */
function isBase64OfAtLeast(v: string, minBytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4 !== 0) return false;
  return Buffer.from(v, 'base64').length >= minBytes;
}

/**
 * Single source of truth for runtime configuration.
 *
 * Convention (build plan §3): configuration comes from environment variables
 * ONLY, and every setting declared here must have a matching entry in
 * `.env.example`. When you add or remove a variable, update `.env.example` in the
 * same change — the two are kept in lockstep.
 *
 * This is the seed set for the scaffold. It grows as features land; no business
 * logic depends on it yet.
 */
export const configSchema = z.object({
  /** Deployment environment. Drives environment separation (dev/staging/prod). */
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),

  /** Postgres connection string. Optional here: presence + reachability are owned
   * by the boot readiness check, which emits DATABASE_UNAVAILABLE rather than
   * CONFIG_MISSING_OR_INVALID so the store-specific code always surfaces. */
  DATABASE_URL: z.string().min(1).optional(),

  /** Redis connection string (BullMQ backend). Optional for the same reason as
   * DATABASE_URL — readiness owns it and emits REDIS_UNAVAILABLE. */
  REDIS_URL: z.string().min(1).optional(),

  /** Readiness: Postgres connect timeout (ms). Fail fast, never hang. */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** Readiness: Redis connect timeout (ms). Fail fast, never hang. */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** pino log level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Service name attached to every log line. */
  SERVICE_NAME: z.string().min(1).default('gcp-call-insights'),

  /** HTTP port for internal surfaces. */
  PORT: z.coerce.number().int().positive().default(8080),

  /** Envelope-encryption key source. `local` derives DEKs from CRYPTO_LOCAL_MASTER_KEY
   * (dev/test only); `kms` is the external key service (Task 8.2). */
  CRYPTO_KEY_PROVIDER: z.enum(['local', 'kms']).default('local'),

  /** Base64-encoded master secret for the local key provider (>= 32 bytes decoded).
   * Optional here — like DATABASE_URL, the consumer validates it: keyProviderFromConfig
   * throws if it is missing/short when the local provider is actually built. Never a
   * real value in the repo. */
  CRYPTO_LOCAL_MASTER_KEY: z.string().min(44).optional(),

  /** key_version new writes encrypt under. */
  CRYPTO_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().default(1),

  /** BullMQ queue name for the per-call pipeline (Task 2.1). */
  WORKER_QUEUE_NAME: z.string().min(1).default('call-pipeline'),

  /** Worker concurrency: how many calls the pipeline worker processes at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  /** Capped retry count per job (BullMQ `attempts`). Includes the first attempt. */
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /** Base delay (ms) for the exponential backoff between retries. */
  WORKER_BACKOFF_MS: z.coerce.number().int().positive().default(1000),

  /** Minutes an unacknowledged critical alert may sit before it escalates (Task 2.2).
   * The escalation cron (later task) passes this as the window to `escalateStaleAlerts`. */
  ALERT_ESCALATION_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  /** Kill switch: when `true`, the worker boots but does NOT consume — queued jobs
   * accumulate untouched in Redis. Explicit string enum, never truthy-coerced (so the
   * literal 'false' does not read as true). */
  WORKER_KILL_SWITCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- Shared HTTP hardening & auth middleware (Task 2.3) ---

  /** Max accepted request body size (bytes). Larger bodies are rejected before parsing
   * with REQUEST_BODY_TOO_LARGE. Default 1 MiB. */
  HTTP_MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),

  /** Comma-separated allowlist of CORS origins. Empty (the default) denies all cross-origin
   * requests — a surface opts in explicitly by setting this. */
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  /** Trusted reverse-proxy hop count for deriving the real client IP (Railway puts one
   * proxy in front). Fastify `trustProxy` is set to this exact number — never `true`, which
   * would let clients spoof X-Forwarded-For. `0` disables proxy trust. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

  /** Tier-1 (per-IP) rate limit: a coarse guard covering all traffic from one address
   * (including many users behind a shared NAT), so it is deliberately generous. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /** Tier-2 (per-authenticated-user) rate limit: per-identity fairness, applied after auth.
   * Kept below the IP tier so one user cannot exhaust the shared IP budget. */
  USER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  USER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /** Webhook rate limit (per provider/IP): higher/burstier than the internal tier. */
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /** Replay-protection window (ms): how long a seen `provider:eventId` is remembered. */
  WEBHOOK_REPLAY_WINDOW_MS: z.coerce.number().int().positive().default(300_000),

  /** Max allowed clock skew (ms) for a webhook timestamp, in either direction. A stale or
   * future timestamp beyond this is rejected with WEBHOOK_TIMESTAMP_INVALID. */
  WEBHOOK_TIMESTAMP_SKEW_MS: z.coerce.number().int().positive().default(300_000),

  /** Secret that signs the session cookie. Optional here (like DATABASE_URL); the auth
   * plugin validates presence when it is actually built, emitting CONFIG_MISSING_OR_INVALID.
   * Never a real value in the repo. */
  SESSION_SECRET: z.string().min(32).optional(),

  /** Session cookie name. */
  SESSION_COOKIE_NAME: z.string().min(1).default('sid'),

  /** Server-side session lifetime (ms). Default 8h. */
  SESSION_TTL_MS: z.coerce.number().int().positive().default(28_800_000),

  /** Whether the session cookie carries the `Secure` flag. Defaults true; may be `false`
   * only in dev/test (over plain HTTP). The auth plugin refuses `false` in staging/prod. */
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** OIDC provider settings. All optional here; the OIDC adapter validates presence when
   * built (tests inject a fake AuthProvider and never need real values). */
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().min(1).default('openid profile email'),

  // --- Dialpad transcript client (Task 3.3) ---

  /** Dialpad API base URL (v2). Confirmed against the public API reference. */
  DIALPAD_BASE_URL: z.string().url().default('https://dialpad.com/api/v2'),

  /** Dialpad API key (used as a Bearer token; an OAuth access token works the same way).
   * Optional at boot like DATABASE_URL — the consumer (worker / reconciliation cron)
   * fail-fast-validates presence via requireDialpadConfig, emitting
   * CONFIG_MISSING_OR_INVALID that NAMES this variable. Never a real value in the repo. */
  DIALPAD_API_KEY: z.string().min(1).optional(),

  /** Per-request timeout (ms) for a Dialpad HTTP call. Fail fast, never hang. */
  DIALPAD_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /** Retries AFTER the first attempt for 429 / 5xx / timeout (⇒ up to 1 + this total HTTP
   * calls). Distinct from WORKER_MAX_ATTEMPTS, which INCLUDES the first attempt. */
  DIALPAD_API_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),

  /** Base delay (ms) for the client's exponential backoff + full jitter between retries. */
  DIALPAD_API_BACKOFF_MS: z.coerce.number().int().positive().default(500),

  /** Transcript-endpoint rate limit: requests per minute (Dialpad documents 1200/min). */
  DIALPAD_RATE_PER_MINUTE: z.coerce.number().int().positive().default(1200),

  /** Company-wide rate limit: requests per second. The shared limiter enforces the tighter
   * of this and the per-minute cap across every worker + cron instance. */
  DIALPAD_RATE_PER_SECOND: z.coerce.number().int().positive().default(20),

  /** How long (ms) a not-yet-ready transcript may be waited on before the call is held with
   * missing_transcript. Default 30 min. */
  DIALPAD_TRANSCRIPT_WAIT_MAX_MS: z.coerce.number().int().positive().default(1_800_000),

  /** Delay (ms) between not-ready transcript retries (the delayed re-enqueue cadence). */
  DIALPAD_TRANSCRIPT_POLL_MS: z.coerce.number().int().positive().default(60_000),

  // --- Reconciliation cron (Task 3.4) ---

  /** Lookback window (minutes) for the reconciliation sweep. Deliberately LONGER than the
   * 15-minute cron cadence so consecutive runs overlap and a delayed or missed run still
   * catches every concluded call; idempotent enqueue makes the overlap harmless. */
  RECONCILIATION_WINDOW_MINUTES: z.coerce.number().int().positive().default(45),

  /** Longest plausible call (minutes). Dialpad's list API filters by START time only, so the
   * sweep queries `started_after = window + this margin` back — otherwise a long call that
   * started before the window but CONCLUDED inside it would never be listed. Over-listing is
   * harmless: already-ingested calls are skipped idempotently. */
  RECONCILIATION_MAX_CALL_MINUTES: z.coerce.number().int().positive().default(180),

  /** The reconciliation cron's OWN dead-man's-switch URL, pinged only after a fully
   * successful sweep. Optional in the schema (local dev / tests skip the ping), but the
   * cron entrypoint REQUIRES it in staging/production via requireCheckUrl. */
  RECONCILIATION_CHECK_URL: z.string().url().optional(),

  // --- Per-component dead-man's switches (Task 7.1) ---

  /** The WORKER's OWN external check URL, pinged every WORKER_HEARTBEAT_INTERVAL_MS to prove
   * liveness (not throughput). Optional in the schema (dev/test skip it); the worker
   * entrypoint REQUIRES it in staging/production via requireCheckUrl(config, 'worker'). Kept
   * separate from the cron URLs on purpose — a shared check would stay green while one
   * component is dead. */
  WORKER_CHECK_URL: z.string().url().optional(),

  /** The RETENTION cron's OWN external check URL, pinged only after a fully successful run.
   * Optional in the schema; REQUIRED in staging/production via requireCheckUrl. */
  RETENTION_CHECK_URL: z.string().url().optional(),

  /** How often (ms) the worker pings its liveness check while booted and its queue/Redis
   * dependencies are healthy. Must be shorter than the external monitor's grace period. */
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /** Per-request timeout (ms) for the provider-neutral heartbeat HTTP GET. Fail fast, never
   * hang a beat waiting on an unreachable monitor. */
  HEARTBEAT_PING_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // --- Classify stage / model spend (Task 5.1) ---

  /** Anthropic API key. Optional here — like DIALPAD_API_KEY, the consumer (the Anthropic
   * client construction) validates presence, not boot. Never a real value in the repo. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /** Model ID for the classify stage. Never hardcoded outside config — a model swap is a
   * config change, not a code change. */
  CLASSIFY_MODEL_ID: z.string().min(1).default('claude-haiku-4-5-20251001'),

  /** Kill switch: explicit string enum, never truthy-coerced (the EXACT WORKER_KILL_SWITCH
   * pattern). Defaults false: while off, the classify stage makes no Anthropic calls. */
  CLASSIFY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Max output tokens requested per classify call. */
  CLASSIFY_MAX_TOKENS: z.coerce.number().int().positive().default(512),

  /** Cost-reservation floor (input tokens): the classify handler reserves against
   * max(this ceiling, payload byte-estimate) so short-transcript calls never under-reserve
   * against the daily cap. */
  CLASSIFY_INPUT_TOKENS_CEILING: z.coerce.number().int().positive().default(30_000),

  /** Fixed structured-output/request-scaffolding overhead (tokens) added to the byte-bound
   * payload estimate when reserving against the daily cost cap. */
  CLASSIFY_RESERVATION_OVERHEAD_TOKENS: z.coerce.number().int().nonnegative().default(1_000),

  /** Anthropic TS SDK request timeout in milliseconds. The SDK accepts a `timeout` client
   * option natively; the Dialpad client hand-rolls an AbortController timer around fetch. */
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Daily hard cap (USD) on model spend, enforced across ALL model stages, not just
   * classify. */
  DAILY_MODEL_COST_CAP_USD: z.coerce.number().positive().default(25),

  /** Fraction of `DAILY_MODEL_COST_CAP_USD` at which an advisory warning alert
   * (`MODEL_COST_WARNING_THRESHOLD_EXCEEDED`) is emitted — at most once per UTC day, without
   * ever blocking the pipeline (Task 7.2). A strict fraction in (0, 1): 0 would alert on every
   * call and 1 (or above) would collapse the warning onto the hard cap. */
  DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO: z.coerce.number().gt(0).lt(1).default(0.8),

  /** Haiku 4.5 list price per million input/output tokens (USD). Deliberately
   * classify-scoped, not shared: Task 5.2 adds its own EXTRACT_* rates for Sonnet, and the
   * shared cost helper takes explicit rates with no defaults so a different model can never
   * silently inherit Haiku pricing. */
  CLASSIFY_COST_USD_PER_MTOK_INPUT: z.coerce.number().nonnegative().default(1),
  CLASSIFY_COST_USD_PER_MTOK_OUTPUT: z.coerce.number().nonnegative().default(5),

  // --- Redaction stage (Task 4.1) ---

  /** Risk score at or above which a call is held with redaction_failed. Forced-hold
   * reasons (offset alignment failure, residual hit) hold regardless of this value. */
  REDACTION_RISK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  /** Labeled-corpus recall the CI gate enforces; below it the suite fails with
   * REDACTION_RECALL_REGRESSION. Consumed by tests, not the per-call path. */
  REDACTION_RECALL_TARGET: z.coerce.number().min(0).max(1).default(0.95),

  /** Path to a newline-delimited file of client-specific deny-list terms that must never
   * pass redaction. Absent ⇒ empty deny list. The file lives outside the repo. */
  REDACTION_DENY_LIST_PATH: z.string().min(1).optional(),

  /** transformers.js model id for the NER pass. Vendored locally at build time by
   * `npm run model:fetch`; never downloaded in the per-call path. */
  REDACTION_NER_MODEL_ID: z.string().min(1).default('Xenova/bert-base-NER'),

  /** Local directory the vendored NER model lives in (transformers.js cacheDir). */
  REDACTION_NER_MODEL_DIR: z.string().min(1).default('models'),

  /** NER spans below this confidence still get redacted (fail closed) but raise the
   * ner_low_confidence risk reason. */
  REDACTION_NER_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),

  /** Chunk size (chars) for splitting long transcripts under the model's token window. */
  REDACTION_NER_CHUNK_CHARS: z.coerce.number().int().positive().default(1500),

  /** Overlap (chars) between adjacent chunks so boundary-spanning entities are seen
   * whole in at least one chunk. */
  REDACTION_NER_CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(250),

  /** Base64 key (>= 32 bytes decoded) for the per-call HMAC over normalized detected
   * values stored in redaction_findings.value_hash. Optional at boot like
   * CRYPTO_LOCAL_MASTER_KEY — requireRedactionConfig enforces presence wherever the
   * redaction stage is actually built. Never a real value in the repo. */
  REDACTION_VALUE_HASH_KEY: z
    .string()
    .optional()
    .refine((v) => v === undefined || isBase64OfAtLeast(v, 32), {
      message: 'must be base64 that decodes to at least 32 bytes',
    }),

  // --- Extract stage / model spend (Task 5.2) ---

  /** Model ID for the extract stage. Never hardcoded outside config — a model swap is a
   * config change, not a code change. */
  EXTRACT_MODEL_ID: z.string().min(1).default('claude-sonnet-4-6'),

  /** Kill switch: explicit string enum, never truthy-coerced (the EXACT CLASSIFY_ENABLED
   * pattern). Defaults false: the 4.1/5.1 chain is not yet live end-to-end. Recovery via
   * requeue-parked-extract after enabling. */
  EXTRACT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Max output tokens requested per extract call. */
  EXTRACT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  /** Cost-reservation floor (input tokens): the extract handler reserves against
   * max(this ceiling, payload byte-estimate) so short-transcript calls never under-reserve
   * against the daily cap. */
  EXTRACT_INPUT_TOKENS_CEILING: z.coerce.number().int().positive().default(30_000),

  /** Fixed structured-output/request-scaffolding overhead (tokens) added to the byte-bound
   * payload estimate when reserving against the daily cost cap. */
  EXTRACT_RESERVATION_OVERHEAD_TOKENS: z.coerce.number().int().nonnegative().default(1_000),

  /** Sonnet list price per million input/output tokens (USD). Deliberately extract-scoped,
   * not shared: the shared cost helper takes explicit rates with no defaults so a different
   * model can never silently inherit the wrong pricing. */
  EXTRACT_COST_USD_PER_MTOK_INPUT: z.coerce.number().nonnegative().default(3),
  EXTRACT_COST_USD_PER_MTOK_OUTPUT: z.coerce.number().nonnegative().default(15),

  // --- Status surface + alert delivery (Task 7.3) ---

  /** Auto-refresh cadence (seconds) for the server-rendered `/status` page via a plain
   * `<meta http-equiv=refresh>` — load/refresh only, no streaming or per-call animation.
   * `0` disables auto-refresh (a manual refresh link is always present). */
  STATUS_PAGE_REFRESH_SECONDS: z.coerce.number().int().nonnegative().default(30),

  /** Staleness thresholds (ms) for the in-DB component heartbeat mirror: a component whose
   * `component_heartbeats.last_run_at` is older than its threshold renders `broken`. Applied
   * ONLY to the periodic-liveness components (worker + crons); the webhook receiver is
   * liveness-vs-activity split and never goes `broken` from inbound-traffic idleness. Sized
   * per cadence: worker beats each WORKER_HEARTBEAT_INTERVAL_MS (minutes), reconciliation runs
   * every ~15 min, retention runs daily (~26h). Defaults leave slack for one missed tick. */
  WORKER_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(180_000),
  RECONCILIATION_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(2_700_000),
  RETENTION_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(93_600_000),

  /** Outbound Slack-compatible alert webhook (`{text}` POST). Optional locally and in the
   * schema; delivery no-ops (rows stay `pending`, the sweep retries) when unset. The alerting
   * entrypoint fail-fast-requires it in staging/production so critical alerts are never
   * silently undeliverable. Never a real value in the repo. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  /** Per-request timeout (ms) for the outbound alert-webhook POST. Fail fast, never hang. */
  ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /** Max delivery attempts per alert row before the retry sweep stops trying (the row stays
   * `failed`, visible for manual follow-up). Includes the immediate attempt. */
  ALERT_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  /** Base delay (ms) for the alert-delivery exponential backoff between retries. The sweep
   * schedules `next_attempt_at = now + base * 2^(attempts-1)`. */
  ALERT_DELIVERY_BACKOFF_MS: z.coerce.number().int().positive().default(60_000),
});

/** Validated, typed configuration object. */
export type Config = z.infer<typeof configSchema>;
