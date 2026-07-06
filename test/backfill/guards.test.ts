import { describe, expect, it } from 'vitest';
import { makeTestConfig } from '../_config.js';
import { assertBackfillEnvironment } from '../../src/backfill/guards.js';
import { BackfillError } from '../../src/backfill/errors.js';
import { requireCheckUrl } from '../../src/heartbeat/index.js';
import { ConfigError } from '../../src/config/index.js';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof BackfillError) return err.reason;
    throw err;
  }
  return undefined;
}

describe('assertBackfillEnvironment (R3 #1: real backfill is production-only)', () => {
  it.each(['development', 'test'] as const)('refuses %s as not_live_environment', (env) => {
    expect(reasonOf(() => assertBackfillEnvironment(makeTestConfig({ NODE_ENV: env }), {}))).toBe(
      'not_live_environment',
    );
  });

  it('allows production with NO fixture (real mode)', () => {
    const mode = assertBackfillEnvironment(makeTestConfig({ NODE_ENV: 'production' }), {});
    expect(mode).toBe('production-real');
  });

  it('refuses production WITH a synthetic fixture as production_no_synthetic', () => {
    expect(
      reasonOf(() =>
        assertBackfillEnvironment(makeTestConfig({ NODE_ENV: 'production' }), {
          syntheticDialpadFixture: '/tmp/fixture.json',
        }),
      ),
    ).toBe('production_no_synthetic');
  });

  it('refuses staging WITHOUT a synthetic fixture as staging_requires_synthetic', () => {
    expect(
      reasonOf(() => assertBackfillEnvironment(makeTestConfig({ NODE_ENV: 'staging' }), {})),
    ).toBe('staging_requires_synthetic');
  });

  it('allows staging WITH a synthetic fixture (synthetic mode)', () => {
    const mode = assertBackfillEnvironment(makeTestConfig({ NODE_ENV: 'staging' }), {
      syntheticDialpadFixture: '/tmp/fixture.json',
    });
    expect(mode).toBe('staging-synthetic');
  });
});

describe('requireCheckUrl(config, "backfill")', () => {
  it('requires BACKFILL_CHECK_URL in staging/production (CONFIG_MISSING_OR_INVALID names it)', () => {
    let caught: unknown;
    try {
      requireCheckUrl(makeTestConfig({ NODE_ENV: 'production' }), 'backfill');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String((caught as Error).message)).toMatch(/BACKFILL_CHECK_URL/);
  });

  it('is optional in dev/test', () => {
    expect(() => requireCheckUrl(makeTestConfig({ NODE_ENV: 'test' }), 'backfill')).not.toThrow();
  });
});
