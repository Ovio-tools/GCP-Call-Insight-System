import type { HeldReason } from '../src/db/enums.js';
import { configSchema, type Config } from '../src/config/schema.js';

/**
 * A valid SLA map for tests: every `HELD_REASON` present, `emergency_review` the strict
 * minimum, and every value at/above the scan cadence (15). Keep this exhaustive — the schema
 * fails closed on a missing reason, so an incomplete map here would break every test that
 * builds a config.
 */
export const DEFAULT_REVIEW_SLA_MINUTES_BY_REASON: Record<HeldReason, number> = {
  emergency_review: 15,
  redaction_failed: 60,
  residual_pii_detected: 60,
  classifier_uncertain: 120,
  malformed_model_output: 120,
  schema_invalid: 120,
  missing_transcript: 240,
  cost_cap_held: 240,
  weak_servicetitan_match: 480,
  classified_spam: 1440,
};

/**
 * The Task 6.1 review-queue settings that are REQUIRED with no schema default (fail-closed):
 * a raw-env fragment tests spread into a hand-built environment so `validateEnv` /
 * `configSchema.parse` still succeed. Kept here as the single source so a schema change only
 * touches one place.
 */
export const REQUIRED_REVIEW_ENV: Record<string, string> = {
  REVIEW_SLA_MINUTES_BY_REASON: JSON.stringify(DEFAULT_REVIEW_SLA_MINUTES_BY_REASON),
  REVIEW_HELD_RAW_RETENTION_CAP_HOURS: '24',
};

/**
 * A fully-defaulted `Config` for tests, with `overrides` applied on top.
 *
 * The base is produced by parsing the real schema with `NODE_ENV` plus the required-without-
 * default Task 6.1 review settings ({@link REQUIRED_REVIEW_ENV}), so every defaulted field
 * comes from the single source of truth in `config/schema.ts`. This means adding a new config
 * setting with a default never breaks these test literals — the schema fills it in.
 * Optional-without-default settings (DATABASE_URL, REDIS_URL, CRYPTO_LOCAL_MASTER_KEY,
 * SESSION_SECRET, OIDC_*) stay absent unless a test overrides them.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const base = configSchema.parse({ NODE_ENV: 'test', ...REQUIRED_REVIEW_ENV });
  return { ...base, ...overrides };
}

/**
 * A fixed SLA resolver for pipeline tests — the "shared test helper" that supplies
 * `runPipeline`'s required `slaMinutesFor` without threading a whole config through every call
 * site. Backed by {@link DEFAULT_REVIEW_SLA_MINUTES_BY_REASON}, so it is total over every
 * held_reason.
 */
export const testSlaMinutesFor = (reason: HeldReason): number =>
  DEFAULT_REVIEW_SLA_MINUTES_BY_REASON[reason];
