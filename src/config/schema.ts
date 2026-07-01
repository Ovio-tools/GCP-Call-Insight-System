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

  /** Kill switch: when `true`, the worker boots but does NOT consume — queued jobs
   * accumulate untouched in Redis. Explicit string enum, never truthy-coerced (so the
   * literal 'false' does not read as true). */
  WORKER_KILL_SWITCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** Validated, typed configuration object. */
export type Config = z.infer<typeof configSchema>;
