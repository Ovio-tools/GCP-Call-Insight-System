import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config/schema.js';
import { assertDependenciesReady, type PgProbe, type RedisProbe } from '../src/boot/readiness.js';
import { makeTestConfig } from './_config.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return makeTestConfig({
    DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    SERVICE_NAME: 'test',
    ...overrides,
  });
}

const silentLogger = { fatal: vi.fn(), flush: vi.fn() } as unknown as Logger;

function okPg(): PgProbe {
  return {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  };
}
function okRedis(): RedisProbe {
  return { ping: vi.fn(() => Promise.resolve('PONG')), quit: vi.fn(() => Promise.resolve('OK')) };
}

describe('assertDependenciesReady', () => {
  it('does not exit when Postgres and Redis are both reachable', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    await assertDependenciesReady(baseConfig(), silentLogger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits DATABASE_UNAVAILABLE when DATABASE_URL is missing', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    await assertDependenciesReady(baseConfig({ DATABASE_URL: undefined }), logger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'DATABASE_UNAVAILABLE' });
  });

  it('exits DATABASE_UNAVAILABLE when Postgres connect fails', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    const end = vi.fn(() => Promise.resolve());
    const failingPg: PgProbe = {
      connect: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      query: vi.fn(() => Promise.resolve()),
      end,
    };
    await assertDependenciesReady(baseConfig(), logger, {
      createPg: () => failingPg,
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'DATABASE_UNAVAILABLE' });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('exits REDIS_UNAVAILABLE when REDIS_URL is missing (worker QA)', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    await assertDependenciesReady(baseConfig({ REDIS_URL: undefined }), logger, {
      createPg: () => okPg(),
      createRedis: () => okRedis(),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'REDIS_UNAVAILABLE' });
  });

  it('exits REDIS_UNAVAILABLE when Redis ping fails', async () => {
    const exit = vi.fn((_c: number) => undefined as never);
    const fatal = vi.fn();
    const logger = { fatal, flush: vi.fn() } as unknown as Logger;
    const quit = vi.fn(() => Promise.resolve('OK'));
    const failingRedis: RedisProbe = {
      ping: vi.fn(() => Promise.reject(new Error('connect ETIMEDOUT'))),
      quit,
    };
    await assertDependenciesReady(baseConfig(), logger, {
      createPg: () => okPg(),
      createRedis: () => failingRedis,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ error_code: 'REDIS_UNAVAILABLE' });
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
