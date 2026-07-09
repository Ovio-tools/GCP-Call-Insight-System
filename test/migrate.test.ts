import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { runMigrations, type MigrationRunner } from '../src/boot/migrate-runner.js';
import { runConfiguredMigrations, type MigrateEnv } from '../src/scripts/migrate.js';

describe('runMigrations', () => {
  it('invokes the runner with count Infinity on up', async () => {
    const runner = vi.fn<MigrationRunner>(() => Promise.resolve([]));
    await runMigrations('up', {
      runner,
      databaseUrl: 'postgres://user:pw@localhost:5432/db',
      migrationsDir: 'migrations',
    });
    expect(runner).toHaveBeenCalledTimes(1);
    const opts = runner.mock.calls[0]?.[0];
    expect(opts?.direction).toBe('up');
    expect(opts?.count).toBe(Infinity);
    expect(opts?.databaseUrl).toBe('postgres://user:pw@localhost:5432/db');
    expect(opts?.dir).toBe('migrations');
    // README.md / dotfiles must be ignored, else node-pg-migrate imports them and crashes.
    expect(opts?.ignorePattern).toBe('(\\..*|.*\\.md)');
  });

  it('passes count 1 on down', async () => {
    const runner = vi.fn<MigrationRunner>(() => Promise.resolve([]));
    await runMigrations('down', { runner, databaseUrl: 'postgres://x@localhost/db' });
    const opts = runner.mock.calls[0]?.[0];
    expect(opts?.direction).toBe('down');
    expect(opts?.count).toBe(1);
  });

  it('throws MIGRATION_FAILED when the runner rejects', async () => {
    const runner = vi.fn<MigrationRunner>(() =>
      Promise.reject(new Error('relation already exists')),
    );
    await expect(
      runMigrations('up', { runner, databaseUrl: 'postgres://x@localhost/db' }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
  });

  it('throws MIGRATION_FAILED when DATABASE_URL is absent', async () => {
    // Omit databaseUrl (exactOptionalPropertyTypes forbids passing `undefined`) and
    // clear the env fallback so the real "no target" path is exercised.
    const runner = vi.fn<MigrationRunner>(() => Promise.resolve([]));
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(runMigrations('up', { runner })).rejects.toMatchObject({
        code: 'MIGRATION_FAILED',
      });
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('runConfiguredMigrations', () => {
  const fakeLogger = (): Logger => ({ info: vi.fn(), error: vi.fn() }) as unknown as Logger;

  it('migrates only DB-A when RAW_DATABASE_URL is absent', async () => {
    const run = vi.fn<typeof runMigrations>(() => Promise.resolve());
    const env: MigrateEnv = {};
    await runConfiguredMigrations('up', fakeLogger(), env, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(['up']);
  });

  it('migrates DB-A then DB-B (raw-store) when RAW_DATABASE_URL is set (up)', async () => {
    const run = vi.fn<typeof runMigrations>(() => Promise.resolve());
    const env: MigrateEnv = { RAW_DATABASE_URL: 'postgres://b' };
    await runConfiguredMigrations('up', fakeLogger(), env, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(['up']);
    expect(run.mock.calls[1]).toEqual([
      'up',
      { databaseUrl: 'postgres://b', migrationsDir: 'migrations-raw' },
    ]);
  });

  it('rolls back both stores symmetrically on down', async () => {
    const run = vi.fn<typeof runMigrations>(() => Promise.resolve());
    const env: MigrateEnv = { RAW_DATABASE_URL: 'postgres://b' };
    await runConfiguredMigrations('down', fakeLogger(), env, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(['down']);
    expect(run.mock.calls[1]).toEqual([
      'down',
      { databaseUrl: 'postgres://b', migrationsDir: 'migrations-raw' },
    ]);
  });

  it('propagates a DB-A failure and never runs DB-B', async () => {
    const run = vi.fn<typeof runMigrations>();
    run.mockRejectedValueOnce(new Error('MIGRATION_FAILED: DB-A boom'));
    await expect(
      runConfiguredMigrations('up', fakeLogger(), { RAW_DATABASE_URL: 'postgres://b' }, run),
    ).rejects.toThrow('DB-A boom');
    // Fail loud: a DB-A rejection stops before DB-B is ever attempted.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('propagates a DB-B failure after DB-A succeeds', async () => {
    const run = vi.fn<typeof runMigrations>();
    run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('DB-B boom'));
    await expect(
      runConfiguredMigrations('up', fakeLogger(), { RAW_DATABASE_URL: 'postgres://b' }, run),
    ).rejects.toThrow('DB-B boom');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
