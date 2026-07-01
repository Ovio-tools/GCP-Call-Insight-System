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
});

/** Validated, typed configuration object. */
export type Config = z.infer<typeof configSchema>;
