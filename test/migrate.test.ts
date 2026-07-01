import { describe, expect, it, vi } from 'vitest';
import { runMigrations, type MigrationRunner } from '../src/boot/migrate-runner.js';

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
