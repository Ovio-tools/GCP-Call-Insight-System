import { z } from 'zod';

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
   * cron entrypoint REQUIRES it in production via requireReconciliationCheckUrl. */
  RECONCILIATION_CHECK_URL: z.string().url().optional(),

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

  /** Anthropic TS SDK request timeout. Unlike DIALPAD_API_TIMEOUT_MS's HTTP client, the SDK
   * takes this in milliseconds directly. */
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Daily hard cap (USD) on model spend, enforced across ALL model stages, not just
   * classify. */
  DAILY_MODEL_COST_CAP_USD: z.coerce.number().positive().default(25),

  /** Haiku 4.5 list price per million input/output tokens (USD). Deliberately
   * classify-scoped, not shared: Task 5.2 adds its own EXTRACT_* rates for Sonnet, and the
   * shared cost helper takes explicit rates with no defaults so a different model can never
   * silently inherit Haiku pricing. */
  CLASSIFY_COST_USD_PER_MTOK_INPUT: z.coerce.number().nonnegative().default(1),
  CLASSIFY_COST_USD_PER_MTOK_OUTPUT: z.coerce.number().nonnegative().default(5),
});

/** Validated, typed configuration object. */
export type Config = z.infer<typeof configSchema>;
