import type { Logger } from 'pino';
import pg from 'pg';
import { Redis } from 'ioredis';
import type { Config } from '../config/schema.js';
import {
  DATABASE_UNAVAILABLE,
  REDIS_UNAVAILABLE,
  FatalBootError,
  failBoot,
  sanitizeConnectionContext,
} from './codes.js';

/** Minimal Postgres surface the check needs — satisfied by pg.Client. */
export interface PgProbe {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Minimal Redis surface the check needs — satisfied by ioredis. */
export interface RedisProbe {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export interface ReadinessDeps {
  createPg?: (url: string, connectTimeoutMs: number) => PgProbe;
  createRedis?: (url: string, connectTimeoutMs: number) => RedisProbe;
  exit?: (code: number) => never;
}

function defaultCreatePg(url: string, connectTimeoutMs: number): PgProbe {
  const { Client } = pg;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: connectTimeoutMs });
  // Adapter: pg's Client.connect() resolves to the client itself, not void — narrow it
  // to satisfy PgProbe so the interface stays a minimal, pg-agnostic contract.
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (sql: string) => client.query(sql),
    end: async () => {
      await client.end();
    },
  };
}

function defaultCreateRedis(url: string, connectTimeoutMs: number): RedisProbe {
  // Fail fast, never hang: give up after one try instead of reconnecting forever.
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}

async function checkPostgres(config: Config, deps: ReadinessDeps): Promise<void> {
  if (!config.DATABASE_URL) {
    throw new FatalBootError(
      DATABASE_UNAVAILABLE,
      `${DATABASE_UNAVAILABLE}: DATABASE_URL is not set`,
      {
        missing: 'DATABASE_URL',
      },
    );
  }
  const create = deps.createPg ?? defaultCreatePg;
  const client = create(config.DATABASE_URL, config.DB_CONNECT_TIMEOUT_MS);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (cause) {
    throw new FatalBootError(
      DATABASE_UNAVAILABLE,
      `${DATABASE_UNAVAILABLE}: ${(cause as Error).message}`,
      sanitizeConnectionContext(config.DATABASE_URL),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRawPostgres(config: Config, deps: ReadinessDeps): Promise<void> {
  if (!config.RAW_DATABASE_URL) {
    throw new FatalBootError(
      DATABASE_UNAVAILABLE,
      `${DATABASE_UNAVAILABLE}: RAW_DATABASE_URL is not set`,
      {
        missing: 'RAW_DATABASE_URL',
      },
    );
  }
  const create = deps.createPg ?? defaultCreatePg;
  const client = create(config.RAW_DATABASE_URL, config.DB_CONNECT_TIMEOUT_MS);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (cause) {
    throw new FatalBootError(
      DATABASE_UNAVAILABLE,
      `${DATABASE_UNAVAILABLE}: ${(cause as Error).message}`,
      sanitizeConnectionContext(config.RAW_DATABASE_URL),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRedis(config: Config, deps: ReadinessDeps): Promise<void> {
  if (!config.REDIS_URL) {
    throw new FatalBootError(REDIS_UNAVAILABLE, `${REDIS_UNAVAILABLE}: REDIS_URL is not set`, {
      missing: 'REDIS_URL',
    });
  }
  const create = deps.createRedis ?? defaultCreateRedis;
  const client = create(config.REDIS_URL, config.REDIS_CONNECT_TIMEOUT_MS);
  try {
    await client.ping();
  } catch (cause) {
    throw new FatalBootError(
      REDIS_UNAVAILABLE,
      `${REDIS_UNAVAILABLE}: ${(cause as Error).message}`,
      sanitizeConnectionContext(config.REDIS_URL),
    );
  } finally {
    await client.quit().catch(() => {});
  }
}

/**
 * Confirm Postgres (primary + raw store DB-B) and Redis are reachable at boot. On any
 * failure — missing URL or unreachable store — emit the store-specific code via
 * {@link failBoot} and exit non-zero. The primary Postgres is checked first, then the raw
 * store, then Redis. Clients and the exit hook are injectable so tests run with no live
 * servers.
 */
export async function assertDependenciesReady(
  config: Config,
  logger: Logger,
  deps: ReadinessDeps = {},
): Promise<void> {
  try {
    await checkPostgres(config, deps);
    await checkRawPostgres(config, deps);
    await checkRedis(config, deps);
  } catch (err) {
    if (err instanceof FatalBootError) {
      // Conditional spread: `exactOptionalPropertyTypes` forbids passing
      // `{ exit: undefined }` to an optional `exit?` field.
      failBoot(logger, err, { ...(deps.exit ? { exit: deps.exit } : {}) });
      return;
    }
    throw err;
  }
}
