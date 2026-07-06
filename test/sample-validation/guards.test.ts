import { describe, expect, it } from 'vitest';
import { makeTestConfig } from '../_config.js';
import {
  assertNoProductionResources,
  assertStagingEnvironment,
  SampleValidationError,
} from '../../src/sample-validation/index.js';

describe('assertStagingEnvironment', () => {
  it('passes in staging', () => {
    expect(() => assertStagingEnvironment(makeTestConfig({ NODE_ENV: 'staging' }))).not.toThrow();
  });

  it.each(['production', 'development', 'test'] as const)('refuses in %s', (env) => {
    let caught: unknown;
    try {
      assertStagingEnvironment(makeTestConfig({ NODE_ENV: env }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SampleValidationError);
    expect((caught as SampleValidationError).reason).toBe('not_staging');
    // Sanitized context surfaces the offending env, never a secret.
    expect((caught as SampleValidationError).context.node_env).toBe(env);
  });
});

describe('assertNoProductionResources', () => {
  const staging = {
    databaseUrl: 'postgres://user:pw@db.staging.internal:5432/app',
    queueUrl: 'redis://:pw@redis.staging.internal:6379',
    endpoints: [
      { label: 'dialpad', url: 'https://dialpad.staging.example.com' },
      { label: 'oidc', url: 'https://auth.staging.example.com' },
      { label: 'unset', url: undefined },
    ],
  };

  it('passes when no resource host names a production marker', () => {
    expect(() => assertNoProductionResources(staging)).not.toThrow();
  });

  it('refuses a production database host', () => {
    let caught: unknown;
    try {
      assertNoProductionResources({
        ...staging,
        databaseUrl: 'postgres://u:pw@db.prod.internal:5432/app',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SampleValidationError);
    expect((caught as SampleValidationError).reason).toBe('production_resource');
    expect((caught as SampleValidationError).context.resource).toBe('database');
    // Never leak the connection string (it carries credentials).
    expect(JSON.stringify((caught as SampleValidationError).context)).not.toContain('pw');
  });

  it('refuses a production queue host', () => {
    let caught: unknown;
    try {
      assertNoProductionResources({
        ...staging,
        queueUrl: 'redis://:pw@redis.production.internal:6379',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SampleValidationError);
    expect((caught as SampleValidationError).reason).toBe('production_resource');
    expect((caught as SampleValidationError).context.resource).toBe('queue');
  });

  it('refuses a production service endpoint by its label', () => {
    let caught: unknown;
    try {
      assertNoProductionResources({
        ...staging,
        endpoints: [{ label: 'dialpad', url: 'https://dialpad.prod.example.com' }],
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as SampleValidationError).reason).toBe('production_resource');
    expect((caught as SampleValidationError).context.resource).toBe('dialpad');
  });

  it('does not match a marker inside userinfo/credentials, only the host', () => {
    // "prod" in the password must not trip; the host is staging.
    expect(() =>
      assertNoProductionResources({
        databaseUrl: 'postgres://user:prodpass@db.staging.internal:5432/app',
      }),
    ).not.toThrow();
  });
});
