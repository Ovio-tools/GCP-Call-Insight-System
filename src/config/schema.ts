import { z } from 'zod';
import { HELD_REASON, heldReasonSchema } from '../db/enums.js';
import { NER_ENTITY_SCOPES } from '../redaction/types.js';

/**
 * The reconciliation-cron cadence (minutes) the SLA-breach scan piggybacks on (Task 6.1).
 * A documented policy constant consumed by config validation (below), the ADR, docs, and
 * tests. It bounds the maximum SLA-breach detection latency to one cadence, so config
 * validation floors every per-reason SLA at this value — no SLA may be shorter than the
 * interval at which breaches are detected.
 *
 * ⚠️ DRIFT GUARD: this MUST equal the Railway reconciliation-cron schedule. If that schedule
 * ever changes, update this constant IN THE SAME PR (or promote it to a config value if the
 * cadence must vary by environment).
 */
export const REVIEW_SLA_SCAN_CADENCE_MINUTES = 15;

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
/**
 * A required retention window in DAYS: a positive integer, no default (privacy policy). Used
 * for the four non-CLEAN purge groups (Task 8.1).
 */
function retentionDays(): z.ZodType<number> {
  return z.coerce.number().int().positive();
}

/**
 * The CLEAN group's two-mode window (Task 8.1): a positive integer number of days OR the
 * literal `never` (indefinite/active). `z.coerce.number` would coerce the string `'never'` to
 * NaN, so the numeric branch guards against that; the union then falls through to the literal.
 * Mode agreement + `hard > soft` are enforced across the two sides by the wrapping superRefine.
 */
function cleanRetentionDays(): z.ZodType<number | 'never'> {
  return z.union([
    z.literal('never'),
    z.coerce.number().refine((n) => Number.isInteger(n) && n > 0, {
      message: "must be a positive integer number of days or 'never'",
    }),
  ]);
}

/**
 * The base configuration object. Kept as a plain `ZodObject` (exported) so `.shape`-based
 * consumers (failure-model) keep compiling; the exported {@link configSchema} wraps it with the
 * cross-field retention `superRefine`.
 */
export const configObjectSchema = z.object({
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
   * (dev/test only); `keystore` is the DB-sourced external {@link KeyStore} (Task 8.2,
   * dev/staging via `LocalFileKeyStore`; refused in production pending Task 8.2b); `railway`
   * is the production-capable KeyStore backed by Railway Secrets (Task 8.2c, see ADR 0008);
   * `kms` is the production external key service (Task 8.2b — still throws). */
  CRYPTO_KEY_PROVIDER: z.enum(['local', 'keystore', 'railway', 'kms']).default('local'),

  /** Base64-encoded master secret for the local key provider (>= 32 bytes decoded).
   * Optional here — like DATABASE_URL, the consumer validates it: keyProviderFromConfig
   * throws if it is missing/short when the local provider is actually built. Never a
   * real value in the repo. */
  CRYPTO_LOCAL_MASTER_KEY: z.string().min(44).optional(),

  /** key_version new writes encrypt under (LOCAL provider only; the keystore provider is
   * DB-sourced via the single `status='active'` row). Bootstrap/seed for local. */
  CRYPTO_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // --- External key store (Task 8.2, `keystore` provider) ---

  /** Directory that IS the external secret store for `LocalFileKeyStore` (KEK bytes + wrapped
   * DEK files). Validated by `buildKeyProvider` when the keystore provider is actually built,
   * not here — services that never encrypt boot without it. */
  CRYPTO_KEY_STORE_DIR: z.string().min(1).optional(),

  /** Active KEK version — BOOTSTRAP/SEED ONLY. The live active KEK is DB-sourced via
   * `getActiveKek()` (single `status='active'` row in `kek_versions`); this seeds the first one. */
  CRYPTO_KEK_VERSION: z.string().min(1).optional(),

  /** Mandatory recovery window (days, >= 0) before destroyed key material is truly purged. 0 =
   * immediate (dev). Staging should use a nonzero window; the finalizer confirms unrecoverability
   * only after it elapses. */
  KEY_STORE_RECOVERY_WINDOW_DAYS: z.coerce.number().int().nonnegative().default(0),

  /** Enables/disables the destructive key-lifecycle CLIs (rotate/revoke). This is a KILL SWITCH
   * ONLY — never the approval: every destructive run still requires `--actor`/`--approval-ref`
   * and a typed confirmation phrase at runtime. */
  CRYPTO_KEY_DESTROY_COMMANDS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((s) => s === 'true'),

  /** Max time (ms) rotation waits for in-flight jobs to drain after pausing the queue before it
   * aborts safely (releases locks, resumes the queue, emits KEY_ROTATION_FAILED). */
  KEY_ROTATION_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  /** Delay (ms) the processor backstop re-delays a job by when it sees the maintenance flag for a
   * job it already fetched (moveToDelayed + DelayedError — never consumes a retry). */
  KEY_ROTATION_MAINTENANCE_REQUEUE_DELAY_MS: z.coerce.number().int().positive().default(5_000),

  /** Time (ms) rotation waits AFTER the destroy-request, while the queue is still paused, before
   * resuming — long enough for every worker's active-version cache (see KeyStoreProvider's TTL) to
   * expire, so no worker resumes with a stale active version and writes fresh ciphertext under the
   * just-retired/destroy-requested key. MUST be >= the deployed active-version cache TTL across all
   * encrypting services (default TTL 5s). 0 disables the wait (single-node / no live workers). */
  KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS: z.coerce.number().int().nonnegative().default(6_000),

  // --- Railway-secret key store (production-capable; see ADR 0008) ---
  /** Secret name holding the KEK document. Injected into services at boot; mutated by the CLIs. */
  CRYPTO_KEK_SECRET_NAME: z.string().min(1).default('CRYPTO_KEK_MATERIAL'),
  /** Secret name holding the wrapped-DEK document. */
  CRYPTO_WRAPPED_DEK_SECRET_NAME: z.string().min(1).default('CRYPTO_WRAPPED_DEK_MATERIAL'),
  /** KEK document value (JSON), injected at boot on services. Consumer validates presence. */
  CRYPTO_KEK_MATERIAL: z.string().min(1).optional(),
  /** Wrapped-DEK document value (JSON), injected at boot on services. */
  CRYPTO_WRAPPED_DEK_MATERIAL: z.string().min(1).optional(),
  /** Railway API token — CLIs only, to read/write the two secrets and trigger a redeploy. */
  RAILWAY_API_TOKEN: z.string().min(1).optional(),
  /** Railway environment + service the CLIs mutate secrets on. CLIs validate presence. */
  RAILWAY_ENVIRONMENT_ID: z.string().min(1).optional(),
  RAILWAY_SERVICE_ID: z.string().min(1).optional(),

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

  // --- Dialpad webhook receiver (Task 3.2) ---

  /** Shared secret Dialpad signs each webhook JWT with (HS256). Optional here (like
   * SESSION_SECRET); `registerDialpadWebhook` REQUIRES it in every environment — the
   * verifier cannot authenticate anything without it — and throws
   * CONFIG_MISSING_OR_INVALID if absent. Never a real value in the repo. */
  DIALPAD_WEBHOOK_SECRET: z.string().min(16).optional(),

  /** Previous signing secret, accepted alongside the primary during a zero-downtime
   * rotation overlap. Present only while rotating; removed once Dialpad has cut over. */
  DIALPAD_WEBHOOK_SECRET_PREVIOUS: z.string().min(16).optional(),

  /** Secret keying the one-way HMAC that hashes any phone/name found in a payload before
   * it is stored in the (purgeable) audit row. Optional here so unrelated tests boot, but
   * `registerDialpadWebhook` REQUIRES it in every environment — the route must never have a
   * plaintext-phone/name fallback. Never a real value in the repo. */
  DIALPAD_PII_HASH_SECRET: z.string().min(16).optional(),

  /** How long (ms) a `raw_webhook_events` audit row is retained before the retention cron
   * (Task 8.1) may purge it. Consumed by that cron; the receiver stamps
   * `retention_eligible_at = received_at` at ingest, and the cron applies this window.
   * Default 7 days. */
  RAW_WEBHOOK_RETENTION_MS: z.coerce.number().int().positive().default(604_800_000),

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

  // --- Historical backfill runner (Task 11.2) ---

  /** The backfill runner's OWN job-style dead-man's-switch base URL. The runner derives FOUR
   * distinct signal URLs from it (start/progress/success/fail); a pairwise collision after
   * derivation fails at construction. Optional in the schema (dev/test skip the ping), but the
   * entrypoint REQUIRES it in staging/production via requireCheckUrl(config, 'backfill'). Kept
   * separate from the worker/cron URLs — a shared check would stay green while the backfill is
   * dead. */
  BACKFILL_CHECK_URL: z.string().url().optional(),

  /** Longest plausible call (minutes) for the backfill list query. Dialpad's list API filters by
   * START time only, so the backfill scan reaches back `from - this margin` — otherwise a long
   * call that started before the window but CONCLUDED inside it would never be listed. Larger than
   * the reconciliation margin because a historical backfill may span unusually long calls. */
  BACKFILL_MAX_CALL_MINUTES: z.coerce.number().int().positive().default(240),

  /** How often (ms) the job monitor sends a progress ping while the run is active and within the
   * stall threshold. Periodic cadence (not only on movement); shorter than the external monitor's
   * missing-progress grace. */
  BACKFILL_PROGRESS_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /** How long (ms) the run may make no terminal progress before the monitor WITHHOLDS progress
   * pings so the external monitor's missing-progress window fires the stall alert. Generous: a
   * historical backfill legitimately waits on slow transcript availability. Default 6h. */
  BACKFILL_STALL_THRESHOLD_MS: z.coerce.number().int().positive().default(21_600_000),

  /** Delay (ms) between drain-phase polls that check whether every tracked call reached a terminal
   * state (or dead-lettered) before the terminal success ping. */
  BACKFILL_DRAIN_POLL_MS: z.coerce.number().int().positive().default(15_000),

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

  /** NER spans below this confidence are DROPPED (not redacted) and raise the
   * ner_low_confidence risk reason — the ADR 0006 precision gate. Default tuned
   * empirically (2026-07): weakest corpus-needed name span scores 0.7614, so 0.7 is
   * the highest round value keeping >= 0.05 recall margin. Raising it further trades
   * name recall for precision. */
  REDACTION_NER_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.7),

  /** CSV of NER entity scopes actually redacted (ADR 0006). `person` = PER spans;
   * `numbered_location` = LOC spans only when a house-style number is directly
   * adjacent (suffix-less addresses); `location`/`organization`/`misc` opt back in
   * to bare cities / business names / MISC. Structured PII (phones, emails, street
   * addresses, IDs, cards) is always covered by the regex layer regardless. */
  REDACTION_NER_ENTITY_SCOPE: z
    .string()
    .default('person,numbered_location')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(NER_ENTITY_SCOPES)).nonempty()),

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

  // --- Review queue / held-call retention (Task 6.1) ---

  /**
   * Per-`held_reason` review SLA, in minutes, as a JSON object (e.g.
   * `{"emergency_review":15,"redaction_failed":60,...}`). REQUIRED with no default — the
   * pipeline must not run without an explicit SLA policy (fail-closed). Validated in three
   * layers so a bad value becomes a named CONFIG_MISSING_OR_INVALID rather than a crash:
   *   1. parse JSON inside a transform that reports a Zod issue (malformed JSON ⇒ named
   *      config error, never an uncaught SyntaxError escaping safeParse);
   *   2. every value is a positive integer number of minutes;
   *   3. superRefine asserts (a) every HELD_REASON is present (totality — the completeness
   *      oracle is the enum), (b) `emergency_review` is the STRICT minimum, and (c) every
   *      value is at least {@link REVIEW_SLA_SCAN_CADENCE_MINUTES} so no SLA is shorter than
   *      the breach-detection interval.
   */
  REVIEW_SLA_MINUTES_BY_REASON: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.record(heldReasonSchema, z.coerce.number().int().positive()))
    .superRefine((map, ctx) => {
      // (a) Totality: fail closed on any missing reason, naming it.
      for (const reason of HELD_REASON) {
        if (map[reason] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `missing SLA for held_reason '${reason}'`,
          });
        }
      }
      // (b) emergency_review is the strict minimum: every other present reason must be > it.
      const emergency = map.emergency_review;
      if (emergency !== undefined) {
        for (const reason of HELD_REASON) {
          if (reason === 'emergency_review') continue;
          const value = map[reason];
          if (value !== undefined && value <= emergency) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `emergency_review (${emergency}) must be the strict minimum SLA; '${reason}' (${value}) is not greater`,
            });
          }
        }
      }
      // (c) No SLA shorter than the breach-detection cadence.
      for (const reason of HELD_REASON) {
        const value = map[reason];
        if (value !== undefined && value < REVIEW_SLA_SCAN_CADENCE_MINUTES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `SLA for '${reason}' (${value}) is below the scan cadence (${REVIEW_SLA_SCAN_CADENCE_MINUTES} min)`,
          });
        }
      }
    }),

  /** Max age (hours) an unresolved held call's raw transcript + token vault may be retained
   * before the retention cron (Task 8.1) purges them, regardless of review status. REQUIRED
   * with no default — a raw-PII retention cap must be an explicit decision. */
  REVIEW_HELD_RAW_RETENTION_CAP_HOURS: z.coerce.number().int().positive(),

  // --- Scheduled retention / purge windows (Task 8.1) ---
  //
  // Soft- then hard-delete windows, in DAYS, for the five purge groups. REQUIRED with no
  // default (privacy policy — a purge window must be an explicit decision, like
  // REVIEW_HELD_RAW_RETENTION_CAP_HOURS). `HARD > SOFT` per group is enforced by the
  // cross-field superRefine below, guaranteeing a real recoverable grace gap.

  /** RAW group (`raw_transcripts` + `token_vault`), stamped post-store. */
  RETENTION_RAW_SOFT_DELETE_DAYS: retentionDays(),
  RETENTION_RAW_HARD_DELETE_DAYS: retentionDays(),
  /** WEBHOOK group (`raw_webhook_events`), clock starts at receipt. */
  RETENTION_WEBHOOK_SOFT_DELETE_DAYS: retentionDays(),
  RETENTION_WEBHOOK_HARD_DELETE_DAYS: retentionDays(),
  /** CLEAN group (`clean_transcripts` + `redaction_findings`). Special two-mode value: a
   * positive int (windowed) OR the literal `never` (indefinite/active — kept until
   * review-driven resolution). Both sides must agree on the mode (superRefine). */
  RETENTION_CLEAN_SOFT_DELETE_DAYS: cleanRetentionDays(),
  RETENTION_CLEAN_HARD_DELETE_DAYS: cleanRetentionDays(),
  /** MATCH group (`match_keys`), own short window (writer is Task 12.0). */
  RETENTION_MATCH_KEYS_SOFT_DELETE_DAYS: retentionDays(),
  RETENTION_MATCH_KEYS_HARD_DELETE_DAYS: retentionDays(),
  /** EXTRACT group (`extraction_candidates`), the staging row's own window. */
  RETENTION_EXTRACT_SOFT_DELETE_DAYS: retentionDays(),
  RETENTION_EXTRACT_HARD_DELETE_DAYS: retentionDays(),

  /** Dry-run switch: when `true`, the purge counts eligible rows/groups and writes NOTHING.
   * `false` (default) performs the soft/hard/held-cap deletions. */
  RETENTION_DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((s) => s === 'true'),

  /** Rows deleted per batched pass; the purge loops `LIMIT $batch` until a pass touches 0 rows. */
  RETENTION_PURGE_BATCH_SIZE: z.coerce.number().int().positive().default(1000),

  // --- Review & admin surface (Task 6.2) ---

  /** The role name (matched against `request.user.roles`) a session must carry to perform an
   * elevated raw/vault reveal on the review surface. Optional and fail-closed: when unset, NO
   * session is elevated and every reveal is refused with AUTH_FORBIDDEN — elevated reveal is an
   * explicit per-deployment opt-in. Any authenticated session is still a BASE reviewer (list,
   * detail, and the seven actions); only the raw/vault reveal requires this role. Never a
   * secret. */
  REVIEW_ELEVATED_ROLE: z.string().min(1).optional(),

  // --- Evaluation runner / labeled-examples corpus (Task 6.3) ---

  /** Kill switch for the periodic accuracy check (explicit string enum, never truthy-coerced — the
   * EXACT WORKER_KILL_SWITCH pattern). Defaults false: the weekly eval cron gates on it. Label-sync
   * (the reconciliation-cron duty) runs regardless — capture must beat the CLEAN purge window. */
  EVALUATION_RUN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** When true the accuracy check calls the real models (records model_invocations + honors the
   * cost cap / kill switch). In staging/production, `EVALUATION_RUN_ENABLED=true` + this `false`
   * is a fail-fast CONFIG_MISSING_OR_INVALID — the periodic check must never write a non-live
   * `test_stub` report or ping green without calling the models. The stub path is test/local-only. */
  EVALUATION_LIVE_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** The evaluation cron's OWN dead-man's-switch URL, pinged only after a COMPLETE live run.
   * Optional in the schema (dev/test skip the ping); the eval-run entrypoint REQUIRES it in
   * staging/production via requireCheckUrl(config, 'evaluation-cron'). Kept separate from the other
   * cron URLs on purpose — a shared check would stay green while one component is dead. */
  EVALUATION_CHECK_URL: z.string().url().optional(),

  // --- Knowledge-base surface (Task 10.1) ---

  /** Default page size for the paginated knowledge VIEW (`/knowledge`, `/knowledge.json`) when a
   * request omits `page_size`. Clamped to `[1, KNOWLEDGE_PAGE_SIZE_MAX]`. The cross-field
   * superRefine enforces `DEFAULT <= MAX`. */
  KNOWLEDGE_PAGE_SIZE_DEFAULT: z.coerce.number().int().positive().default(50),

  /** Upper bound for the knowledge view `page_size`; a request asking for more is clamped to it. */
  KNOWLEDGE_PAGE_SIZE_MAX: z.coerce.number().int().positive().default(200),

  /** Hard cap on rows an EXPORT (`export.csv`, `export.json`) returns. The export fetches all
   * rows matching the filters up to this cap and signals truncation (CSV `X-Export-*` headers /
   * JSON `truncated`). Bounds the response size of an all-rows export. */
  KNOWLEDGE_MAX_EXPORT_ROWS: z.coerce.number().int().positive().default(5000),
});

/**
 * Cross-field validation for the retention windows: `HARD > SOFT` per numeric group, and the
 * CLEAN group must be a whole mode (both numeric with `hard > soft`, OR both `never`) — never a
 * half-state. Each issue is pinned to the offending HARD variable's path so `validateEnv`
 * surfaces it as a named CONFIG_MISSING_OR_INVALID. Kept as a wrapping `superRefine` (not a
 * per-field one) because these checks span two sibling variables; `configObjectSchema` above
 * stays a plain `ZodObject` so `.shape` consumers (failure-model) keep working.
 */
export const configSchema = configObjectSchema.superRefine((cfg, ctx) => {
  const numericGroups: ReadonlyArray<readonly [keyof Config, keyof Config]> = [
    ['RETENTION_RAW_SOFT_DELETE_DAYS', 'RETENTION_RAW_HARD_DELETE_DAYS'],
    ['RETENTION_WEBHOOK_SOFT_DELETE_DAYS', 'RETENTION_WEBHOOK_HARD_DELETE_DAYS'],
    ['RETENTION_MATCH_KEYS_SOFT_DELETE_DAYS', 'RETENTION_MATCH_KEYS_HARD_DELETE_DAYS'],
    ['RETENTION_EXTRACT_SOFT_DELETE_DAYS', 'RETENTION_EXTRACT_HARD_DELETE_DAYS'],
  ];
  for (const [softKey, hardKey] of numericGroups) {
    const soft = cfg[softKey] as number;
    const hard = cfg[hardKey] as number;
    if (hard <= soft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hardKey],
        message: `${hardKey} (${hard}) must be greater than ${softKey} (${soft}) so a real recoverable grace window exists`,
      });
    }
  }

  const cleanSoft = cfg.RETENTION_CLEAN_SOFT_DELETE_DAYS;
  const cleanHard = cfg.RETENTION_CLEAN_HARD_DELETE_DAYS;
  const softNever = cleanSoft === 'never';
  const hardNever = cleanHard === 'never';
  if (softNever !== hardNever) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RETENTION_CLEAN_HARD_DELETE_DAYS'],
      message: `CLEAN retention must be a whole mode: set BOTH RETENTION_CLEAN_SOFT_DELETE_DAYS and RETENTION_CLEAN_HARD_DELETE_DAYS to 'never', or BOTH to numeric days — not a mix`,
    });
  } else if (
    typeof cleanSoft === 'number' &&
    typeof cleanHard === 'number' &&
    cleanHard <= cleanSoft
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RETENTION_CLEAN_HARD_DELETE_DAYS'],
      message: `RETENTION_CLEAN_HARD_DELETE_DAYS (${cleanHard}) must be greater than RETENTION_CLEAN_SOFT_DELETE_DAYS (${cleanSoft})`,
    });
  }

  // Knowledge view pagination (Task 10.1): the default page size must not exceed the max, else
  // the clamp `[1, MAX]` would silently shrink an unspecified request below its own default.
  if (cfg.KNOWLEDGE_PAGE_SIZE_DEFAULT > cfg.KNOWLEDGE_PAGE_SIZE_MAX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KNOWLEDGE_PAGE_SIZE_DEFAULT'],
      message: `KNOWLEDGE_PAGE_SIZE_DEFAULT (${cfg.KNOWLEDGE_PAGE_SIZE_DEFAULT}) must be <= KNOWLEDGE_PAGE_SIZE_MAX (${cfg.KNOWLEDGE_PAGE_SIZE_MAX})`,
    });
  }
});

/** Validated, typed configuration object. */
export type Config = z.infer<typeof configObjectSchema>;
