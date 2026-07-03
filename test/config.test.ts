import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG_ERROR_CODE, ConfigError, loadConfig, validateEnv } from '../src/config/index.js';

/** A complete, valid environment. Individual tests remove keys to force failures. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:password@localhost:5432/db',
    LOG_LEVEL: 'info',
    SERVICE_NAME: 'gcp-call-insights',
    PORT: '8080',
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
