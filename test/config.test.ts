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
