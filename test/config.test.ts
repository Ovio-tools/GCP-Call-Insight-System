import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG_ERROR_CODE, ConfigError, loadConfig, validateEnv } from '../src/config/index.js';
import { HELD_REASON } from '../src/db/enums.js';
import { REVIEW_SLA_SCAN_CADENCE_MINUTES } from '../src/config/schema.js';
import { DEFAULT_REVIEW_SLA_MINUTES_BY_REASON, REQUIRED_ENV } from './_config.js';

/** A complete, valid environment. Individual tests remove keys to force failures. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:password@localhost:5432/db',
    LOG_LEVEL: 'info',
    SERVICE_NAME: 'gcp-call-insights',
    PORT: '8080',
    // Required-without-default settings (Task 6.1 review + Task 8.1 retention), so the base
    // env validates.
    ...REQUIRED_ENV,
  };
}

describe('config loader', () => {
  it('exits with the named-value error when a required variable is missing', () => {
    const env = validEnv();
    delete env.NODE_ENV;

    // Capture the exit and the emitted error instead of killing the test runner.
    const exit = vi.fn((_code: number) => undefined as never);
    const onError = vi.fn();

    loadConfig(env, { exit, onError });

    // It exits non-zero...
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    // ...and the error NAMES the missing variable with the stable code.
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0] as ConfigError;
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe(CONFIG_ERROR_CODE);
    expect(error.invalid).toContain('NODE_ENV');
    expect(error.message).toContain(CONFIG_ERROR_CODE);
    expect(error.message).toContain('NODE_ENV');
  });

  it('names every offending variable when several are missing or invalid', () => {
    const env = validEnv();
    delete env.NODE_ENV;
    env.LOG_LEVEL = 'bogus';

    const result = validateEnv(env);

    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows the type for the assertions below
    expect(result.error.invalid).toEqual(expect.arrayContaining(['NODE_ENV', 'LOG_LEVEL']));
    expect(result.error.message).toContain('NODE_ENV');
    expect(result.error.message).toContain('LOG_LEVEL');
  });

  it('accepts a missing DATABASE_URL — readiness owns store reachability', () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    const exit = vi.fn((_code: number) => undefined as never);
    const config = loadConfig(env, { exit });

    expect(exit).not.toHaveBeenCalled();
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it('exits naming LOG_LEVEL when it is invalid (boot path, not a pino crash)', () => {
    // Regression: an invalid LOG_LEVEL must surface as the named config error, not
    // a raw pino stack trace from a logger built at import time.
    const env = validEnv();
    env.LOG_LEVEL = 'bogus';

    const exit = vi.fn((_code: number) => undefined as never);
    const onError = vi.fn();

    loadConfig(env, { exit, onError });

    expect(exit).toHaveBeenCalledWith(1);
    const error = onError.mock.calls[0]?.[0] as ConfigError;
    expect(error.code).toBe(CONFIG_ERROR_CODE);
    expect(error.invalid).toContain('LOG_LEVEL');
    expect(error.message).toContain('LOG_LEVEL');
  });

  it('returns a typed config and does not exit when the environment is valid', () => {
    const exit = vi.fn((_code: number) => undefined as never);

    const config = loadConfig(validEnv(), { exit });

    expect(exit).not.toHaveBeenCalled();
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(8080); // coerced to a number
  });
});

describe('ALERT_ESCALATION_WINDOW_MINUTES (Task 2.2)', () => {
  it('defaults to 15 when unset', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ALERT_ESCALATION_WINDOW_MINUTES).toBe(15);
  });

  it('coerces a numeric string', () => {
    const result = validateEnv({ ...validEnv(), ALERT_ESCALATION_WINDOW_MINUTES: '30' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ALERT_ESCALATION_WINDOW_MINUTES).toBe(30);
  });

  it('rejects non-int, non-positive, and non-numeric values, naming the variable', () => {
    for (const bad of ['1.5', '0', '-1', 'abc', '']) {
      const result = validateEnv({ ...validEnv(), ALERT_ESCALATION_WINDOW_MINUTES: bad });
      expect(result.ok, `value ${JSON.stringify(bad)} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.invalid).toContain('ALERT_ESCALATION_WINDOW_MINUTES');
    }
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('ALERT_ESCALATION_WINDOW_MINUTES');
  });
});

describe('classify stage config (Task 5.1)', () => {
  it('resolves defaults when unset', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.config.CLASSIFY_MODEL_ID).toBe('claude-haiku-4-5-20251001');
    expect(result.config.CLASSIFY_ENABLED).toBe(false);
    expect(result.config.CLASSIFY_MAX_TOKENS).toBe(512);
    expect(result.config.CLASSIFY_INPUT_TOKENS_CEILING).toBe(30_000);
    expect(result.config.CLASSIFY_RESERVATION_OVERHEAD_TOKENS).toBe(1_000);
    expect(result.config.ANTHROPIC_TIMEOUT_MS).toBe(30_000);
    expect(result.config.DAILY_MODEL_COST_CAP_USD).toBe(25);
    expect(result.config.CLASSIFY_COST_USD_PER_MTOK_INPUT).toBe(1);
    expect(result.config.CLASSIFY_COST_USD_PER_MTOK_OUTPUT).toBe(5);
  });

  it("transforms CLASSIFY_ENABLED='true' to a boolean true (WORKER_KILL_SWITCH pattern)", () => {
    const result = validateEnv({ ...validEnv(), CLASSIFY_ENABLED: 'true' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.CLASSIFY_ENABLED).toBe(true);
  });

  it("transforms CLASSIFY_ENABLED='false' to a boolean false explicitly", () => {
    const result = validateEnv({ ...validEnv(), CLASSIFY_ENABLED: 'false' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.CLASSIFY_ENABLED).toBe(false);
  });

  it('rejects a non-enum CLASSIFY_ENABLED value, naming the variable', () => {
    const result = validateEnv({ ...validEnv(), CLASSIFY_ENABLED: 'yes' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('CLASSIFY_ENABLED');
  });

  it('coerces numeric string overrides for the token/cost settings', () => {
    const result = validateEnv({
      ...validEnv(),
      CLASSIFY_MAX_TOKENS: '256',
      CLASSIFY_INPUT_TOKENS_CEILING: '10000',
      CLASSIFY_RESERVATION_OVERHEAD_TOKENS: '0',
      ANTHROPIC_TIMEOUT_MS: '5000',
      DAILY_MODEL_COST_CAP_USD: '50.5',
      CLASSIFY_COST_USD_PER_MTOK_INPUT: '0.8',
      CLASSIFY_COST_USD_PER_MTOK_OUTPUT: '4',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.CLASSIFY_MAX_TOKENS).toBe(256);
    expect(result.config.CLASSIFY_INPUT_TOKENS_CEILING).toBe(10_000);
    expect(result.config.CLASSIFY_RESERVATION_OVERHEAD_TOKENS).toBe(0);
    expect(result.config.ANTHROPIC_TIMEOUT_MS).toBe(5000);
    expect(result.config.DAILY_MODEL_COST_CAP_USD).toBe(50.5);
    expect(result.config.CLASSIFY_COST_USD_PER_MTOK_INPUT).toBe(0.8);
    expect(result.config.CLASSIFY_COST_USD_PER_MTOK_OUTPUT).toBe(4);
  });

  it('accepts an ANTHROPIC_API_KEY string (consumer-validated, like DIALPAD_API_KEY)', () => {
    const result = validateEnv({ ...validEnv(), ANTHROPIC_API_KEY: 'sk-ant-test-key' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  it('rejects a non-positive CLASSIFY_MAX_TOKENS, naming the variable', () => {
    const result = validateEnv({ ...validEnv(), CLASSIFY_MAX_TOKENS: '0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('CLASSIFY_MAX_TOKENS');
  });

  it('rejects a negative CLASSIFY_COST_USD_PER_MTOK_INPUT, naming the variable', () => {
    const result = validateEnv({ ...validEnv(), CLASSIFY_COST_USD_PER_MTOK_INPUT: '-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('CLASSIFY_COST_USD_PER_MTOK_INPUT');
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLASSIFY_MODEL_ID',
      'CLASSIFY_ENABLED',
      'CLASSIFY_MAX_TOKENS',
      'CLASSIFY_INPUT_TOKENS_CEILING',
      'CLASSIFY_RESERVATION_OVERHEAD_TOKENS',
      'ANTHROPIC_TIMEOUT_MS',
      'DAILY_MODEL_COST_CAP_USD',
      'CLASSIFY_COST_USD_PER_MTOK_INPUT',
      'CLASSIFY_COST_USD_PER_MTOK_OUTPUT',
    ]) {
      expect(example).toContain(key);
    }
  });
});

describe('cost warning-threshold config (Task 7.2)', () => {
  it('defaults DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO to 0.8 when unset', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO).toBe(0.8);
  });

  it("coerces a numeric-string override ('0.5')", () => {
    const result = validateEnv({
      ...validEnv(),
      DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO: '0.5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO).toBe(0.5);
  });

  it('rejects out-of-range, boundary, and non-numeric values, naming the variable', () => {
    // The ratio is a strict fraction of the cap: (0, 1) exclusive on both ends. A ratio of 0
    // would alert on every call; a ratio of 1 (or above) collapses the warning onto the cap.
    for (const bad of ['0', '1', '1.5', '-0.1', 'abc', '']) {
      const result = validateEnv({
        ...validEnv(),
        DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO: bad,
      });
      expect(result.ok, `value ${JSON.stringify(bad)} should be rejected`).toBe(false);
      if (result.ok) return;
      expect(result.error.invalid).toContain('DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO');
    }
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO');
  });
});

describe('review-queue / held-call retention config (Task 6.1)', () => {
  it('parses a valid SLA map + retention cap', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const reason of HELD_REASON) {
      expect(result.config.REVIEW_SLA_MINUTES_BY_REASON[reason]).toBe(
        DEFAULT_REVIEW_SLA_MINUTES_BY_REASON[reason],
      );
    }
    expect(result.config.REVIEW_HELD_RAW_RETENTION_CAP_HOURS).toBe(24);
  });

  it('rejects a map missing a HELD_REASON key, naming the variable', () => {
    const partial = { ...DEFAULT_REVIEW_SLA_MINUTES_BY_REASON };
    delete (partial as Record<string, number>).classified_spam;
    const result = validateEnv({
      ...validEnv(),
      REVIEW_SLA_MINUTES_BY_REASON: JSON.stringify(partial),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
    expect(result.error.message).toContain('classified_spam');
  });

  it('rejects a missing REVIEW_HELD_RAW_RETENTION_CAP_HOURS, naming the variable', () => {
    const env = validEnv();
    delete env.REVIEW_HELD_RAW_RETENTION_CAP_HOURS;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_HELD_RAW_RETENTION_CAP_HOURS');
  });

  it('rejects a missing REVIEW_SLA_MINUTES_BY_REASON, naming the variable', () => {
    const env = validEnv();
    delete env.REVIEW_SLA_MINUTES_BY_REASON;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
  });

  it('rejects when emergency_review is not the strict minimum', () => {
    const map = { ...DEFAULT_REVIEW_SLA_MINUTES_BY_REASON, redaction_failed: 15 }; // ties emergency
    const result = validateEnv({
      ...validEnv(),
      REVIEW_SLA_MINUTES_BY_REASON: JSON.stringify(map),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
    expect(result.error.message).toContain('emergency_review');
  });

  it('rejects an SLA value below the scan cadence', () => {
    const map = {
      ...DEFAULT_REVIEW_SLA_MINUTES_BY_REASON,
      classifier_uncertain: REVIEW_SLA_SCAN_CADENCE_MINUTES - 1,
    };
    const result = validateEnv({
      ...validEnv(),
      REVIEW_SLA_MINUTES_BY_REASON: JSON.stringify(map),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
  });

  it('rejects malformed JSON without crashing (named config error, not a SyntaxError)', () => {
    const result = validateEnv({ ...validEnv(), REVIEW_SLA_MINUTES_BY_REASON: 'not-json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
  });

  it('rejects a non-positive / non-int SLA value, naming the variable', () => {
    for (const bad of [0, -1, 1.5]) {
      const map = { ...DEFAULT_REVIEW_SLA_MINUTES_BY_REASON, cost_cap_held: bad };
      const result = validateEnv({
        ...validEnv(),
        REVIEW_SLA_MINUTES_BY_REASON: JSON.stringify(map),
      });
      expect(result.ok, `value ${bad} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.invalid).toContain('REVIEW_SLA_MINUTES_BY_REASON');
    }
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const key of ['REVIEW_SLA_MINUTES_BY_REASON', 'REVIEW_HELD_RAW_RETENTION_CAP_HOURS']) {
      expect(example).toContain(key);
    }
  });
});

describe('retention windows config (Task 8.1)', () => {
  const NUMERIC_GROUPS = [
    ['RETENTION_RAW_SOFT_DELETE_DAYS', 'RETENTION_RAW_HARD_DELETE_DAYS'],
    ['RETENTION_WEBHOOK_SOFT_DELETE_DAYS', 'RETENTION_WEBHOOK_HARD_DELETE_DAYS'],
    ['RETENTION_MATCH_KEYS_SOFT_DELETE_DAYS', 'RETENTION_MATCH_KEYS_HARD_DELETE_DAYS'],
    ['RETENTION_EXTRACT_SOFT_DELETE_DAYS', 'RETENTION_EXTRACT_HARD_DELETE_DAYS'],
    ['RETENTION_CLEAN_SOFT_DELETE_DAYS', 'RETENTION_CLEAN_HARD_DELETE_DAYS'],
  ] as const;

  it('parses the valid windowed configuration', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.RETENTION_RAW_SOFT_DELETE_DAYS).toBe(7);
    expect(result.config.RETENTION_RAW_HARD_DELETE_DAYS).toBe(30);
    expect(result.config.RETENTION_CLEAN_SOFT_DELETE_DAYS).toBe(30);
    expect(result.config.RETENTION_CLEAN_HARD_DELETE_DAYS).toBe(365);
    // Defaults for the two knobs.
    expect(result.config.RETENTION_DRY_RUN).toBe(false);
    expect(result.config.RETENTION_PURGE_BATCH_SIZE).toBe(1000);
  });

  it('rejects each missing required window var, naming it', () => {
    for (const [soft, hard] of NUMERIC_GROUPS) {
      for (const key of [soft, hard]) {
        const env = validEnv();
        delete env[key];
        const result = validateEnv(env);
        expect(result.ok, `missing ${key} should be rejected`).toBe(false);
        if (result.ok) continue;
        expect(result.error.invalid).toContain(key);
      }
    }
  });

  it('rejects a non-positive / non-int window value, naming the variable', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      const result = validateEnv({ ...validEnv(), RETENTION_RAW_SOFT_DELETE_DAYS: bad });
      expect(result.ok, `value ${JSON.stringify(bad)} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.invalid).toContain('RETENTION_RAW_SOFT_DELETE_DAYS');
    }
  });

  it('rejects HARD <= SOFT for every group, naming the offending pair', () => {
    for (const [soft, hard] of NUMERIC_GROUPS) {
      // equal
      const equal = validateEnv({ ...validEnv(), [soft]: '10', [hard]: '10' });
      expect(equal.ok, `${hard} == ${soft} should be rejected`).toBe(false);
      if (!equal.ok) expect(equal.error.invalid).toContain(hard);
      // hard < soft
      const less = validateEnv({ ...validEnv(), [soft]: '10', [hard]: '5' });
      expect(less.ok, `${hard} < ${soft} should be rejected`).toBe(false);
      if (!less.ok) expect(less.error.invalid).toContain(hard);
    }
  });

  it('accepts the CLEAN indefinite mode (both never)', () => {
    const result = validateEnv({
      ...validEnv(),
      RETENTION_CLEAN_SOFT_DELETE_DAYS: 'never',
      RETENTION_CLEAN_HARD_DELETE_DAYS: 'never',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.RETENTION_CLEAN_SOFT_DELETE_DAYS).toBe('never');
    expect(result.config.RETENTION_CLEAN_HARD_DELETE_DAYS).toBe('never');
  });

  it('rejects a mixed CLEAN pair (one never, one numeric)', () => {
    const a = validateEnv({
      ...validEnv(),
      RETENTION_CLEAN_SOFT_DELETE_DAYS: 'never',
      RETENTION_CLEAN_HARD_DELETE_DAYS: '365',
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.invalid).toContain('RETENTION_CLEAN_HARD_DELETE_DAYS');

    const b = validateEnv({
      ...validEnv(),
      RETENTION_CLEAN_SOFT_DELETE_DAYS: '30',
      RETENTION_CLEAN_HARD_DELETE_DAYS: 'never',
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.invalid).toContain('RETENTION_CLEAN_HARD_DELETE_DAYS');
  });

  it('only CLEAN accepts never — a non-CLEAN group rejects never', () => {
    const result = validateEnv({ ...validEnv(), RETENTION_RAW_SOFT_DELETE_DAYS: 'never' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('RETENTION_RAW_SOFT_DELETE_DAYS');
  });

  it('coerces and validates RETENTION_DRY_RUN and RETENTION_PURGE_BATCH_SIZE', () => {
    const on = validateEnv({
      ...validEnv(),
      RETENTION_DRY_RUN: 'true',
      RETENTION_PURGE_BATCH_SIZE: '250',
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.config.RETENTION_DRY_RUN).toBe(true);
    expect(on.config.RETENTION_PURGE_BATCH_SIZE).toBe(250);

    for (const bad of ['maybe', '2']) {
      const result = validateEnv({ ...validEnv(), RETENTION_DRY_RUN: bad });
      expect(result.ok, `dry-run ${bad} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.invalid).toContain('RETENTION_DRY_RUN');
    }
    for (const bad of ['0', '-1', '1.5']) {
      const result = validateEnv({ ...validEnv(), RETENTION_PURGE_BATCH_SIZE: bad });
      expect(result.ok, `batch ${bad} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.error.invalid).toContain('RETENTION_PURGE_BATCH_SIZE');
    }
  });

  it('documents every retention key in .env.example (both CLEAN modes)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const [soft, hard] of NUMERIC_GROUPS) {
      expect(example).toContain(soft);
      expect(example).toContain(hard);
    }
    expect(example).toContain('RETENTION_DRY_RUN');
    expect(example).toContain('RETENTION_PURGE_BATCH_SIZE');
    // The indefinite CLEAN mode is documented alongside the windowed default.
    expect(example).toContain('never');
  });
});

describe('knowledge-base surface config (Task 10.1)', () => {
  it('resolves the planned defaults when unset', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.KNOWLEDGE_PAGE_SIZE_DEFAULT).toBe(50);
    expect(result.config.KNOWLEDGE_PAGE_SIZE_MAX).toBe(200);
    expect(result.config.KNOWLEDGE_MAX_EXPORT_ROWS).toBe(5000);
  });

  it('coerces numeric-string overrides', () => {
    const result = validateEnv({
      ...validEnv(),
      KNOWLEDGE_PAGE_SIZE_DEFAULT: '25',
      KNOWLEDGE_PAGE_SIZE_MAX: '100',
      KNOWLEDGE_MAX_EXPORT_ROWS: '1000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.KNOWLEDGE_PAGE_SIZE_DEFAULT).toBe(25);
    expect(result.config.KNOWLEDGE_PAGE_SIZE_MAX).toBe(100);
    expect(result.config.KNOWLEDGE_MAX_EXPORT_ROWS).toBe(1000);
  });

  it('rejects non-positive / non-integer values, naming the variable', () => {
    for (const key of [
      'KNOWLEDGE_PAGE_SIZE_DEFAULT',
      'KNOWLEDGE_PAGE_SIZE_MAX',
      'KNOWLEDGE_MAX_EXPORT_ROWS',
    ] as const) {
      for (const bad of ['0', '-1', '1.5', 'abc', '']) {
        const result = validateEnv({ ...validEnv(), [key]: bad });
        expect(result.ok, `${key}=${JSON.stringify(bad)} should be rejected`).toBe(false);
        if (result.ok) continue;
        expect(result.error.invalid).toContain(key);
      }
    }
  });

  it('rejects KNOWLEDGE_PAGE_SIZE_DEFAULT greater than KNOWLEDGE_PAGE_SIZE_MAX (schema refine)', () => {
    const result = validateEnv({
      ...validEnv(),
      KNOWLEDGE_PAGE_SIZE_DEFAULT: '201',
      KNOWLEDGE_PAGE_SIZE_MAX: '200',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('KNOWLEDGE_PAGE_SIZE_DEFAULT');
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const key of [
      'KNOWLEDGE_PAGE_SIZE_DEFAULT',
      'KNOWLEDGE_PAGE_SIZE_MAX',
      'KNOWLEDGE_MAX_EXPORT_ROWS',
    ]) {
      expect(example).toContain(key);
    }
  });
});

describe('per-component heartbeat config (Task 7.1)', () => {
  it('resolves defaults when unset', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The two component URLs are consumer-validated (fail-fast in staging/prod), not at boot.
    expect(result.config.WORKER_CHECK_URL).toBeUndefined();
    expect(result.config.RETENTION_CHECK_URL).toBeUndefined();
    expect(result.config.WORKER_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(result.config.HEARTBEAT_PING_TIMEOUT_MS).toBe(5_000);
  });

  it('accepts valid check URLs for the worker and retention cron', () => {
    const result = validateEnv({
      ...validEnv(),
      WORKER_CHECK_URL: 'https://checks.example.com/ping/worker',
      RETENTION_CHECK_URL: 'https://checks.example.com/ping/retention',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.WORKER_CHECK_URL).toBe('https://checks.example.com/ping/worker');
    expect(result.config.RETENTION_CHECK_URL).toBe('https://checks.example.com/ping/retention');
  });

  it('rejects a non-URL WORKER_CHECK_URL, naming the variable', () => {
    const result = validateEnv({ ...validEnv(), WORKER_CHECK_URL: 'not-a-url' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('WORKER_CHECK_URL');
  });

  it('coerces numeric-string overrides for the interval and timeout', () => {
    const result = validateEnv({
      ...validEnv(),
      WORKER_HEARTBEAT_INTERVAL_MS: '15000',
      HEARTBEAT_PING_TIMEOUT_MS: '2000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.WORKER_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(result.config.HEARTBEAT_PING_TIMEOUT_MS).toBe(2_000);
  });

  it('is present in .env.example (kept in lockstep with the schema)', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const key of [
      'WORKER_CHECK_URL',
      'RETENTION_CHECK_URL',
      'WORKER_HEARTBEAT_INTERVAL_MS',
      'HEARTBEAT_PING_TIMEOUT_MS',
    ]) {
      expect(example).toContain(key);
    }
  });
});

describe('key-store config (Task 8.2)', () => {
  it('defaults are sane and keystore is an accepted provider', () => {
    const result = validateEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.KEY_STORE_RECOVERY_WINDOW_DAYS).toBe(0);
    expect(result.config.CRYPTO_KEY_DESTROY_COMMANDS_ENABLED).toBe(false);
    expect(result.config.KEY_ROTATION_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(result.config.KEY_ROTATION_MAINTENANCE_REQUEUE_DELAY_MS).toBeGreaterThan(0);
  });

  it('accepts CRYPTO_KEY_PROVIDER=keystore and parses the destroy kill switch + window', () => {
    const result = validateEnv({
      ...validEnv(),
      CRYPTO_KEY_PROVIDER: 'keystore',
      CRYPTO_KEY_STORE_DIR: '/tmp/ks',
      CRYPTO_KEK_VERSION: 'kek-1',
      KEY_STORE_RECOVERY_WINDOW_DAYS: '7',
      CRYPTO_KEY_DESTROY_COMMANDS_ENABLED: 'true',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.CRYPTO_KEY_PROVIDER).toBe('keystore');
    expect(result.config.KEY_STORE_RECOVERY_WINDOW_DAYS).toBe(7);
    expect(result.config.CRYPTO_KEY_DESTROY_COMMANDS_ENABLED).toBe(true);
  });

  it('rejects a negative KEY_STORE_RECOVERY_WINDOW_DAYS, naming the variable', () => {
    const result = validateEnv({ ...validEnv(), KEY_STORE_RECOVERY_WINDOW_DAYS: '-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('KEY_STORE_RECOVERY_WINDOW_DAYS');
  });

  it('documents the key-store keys in .env.example', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const key of [
      'CRYPTO_KEY_STORE_DIR',
      'CRYPTO_KEK_VERSION',
      'KEY_STORE_RECOVERY_WINDOW_DAYS',
      'CRYPTO_KEY_DESTROY_COMMANDS_ENABLED',
      'KEY_ROTATION_DRAIN_TIMEOUT_MS',
      'KEY_ROTATION_MAINTENANCE_REQUEUE_DELAY_MS',
    ]) {
      expect(example).toContain(key);
    }
  });
});
