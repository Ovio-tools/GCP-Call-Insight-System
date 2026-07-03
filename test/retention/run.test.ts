import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runRetention } from '../../src/retention/run.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';

const CHECK_URL = 'https://checks.example.com/ping/retention';

function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
}

describe('runRetention', () => {
  it('pings its own check exactly once, only after the run succeeds', async () => {
    const { logger } = collectingLogger();
    const pingCheck = vi.fn((_url: string) => Promise.resolve());
    const purge = vi.fn(() => Promise.resolve());
    const config = makeTestConfig({ RETENTION_CHECK_URL: CHECK_URL });

    await runRetention({ config, logger, purge, pingCheck });

    expect(purge).toHaveBeenCalledTimes(1);
    expect(pingCheck).toHaveBeenCalledTimes(1);
    expect(pingCheck).toHaveBeenCalledWith(CHECK_URL);
    // Ordering: the ping is the last thing — it happens after the run body completes.
    expect(pingCheck.mock.invocationCallOrder[0]).toBeGreaterThan(
      purge.mock.invocationCallOrder[0]!,
    );
  });

  it('does not ping when the run throws — the missed check is the alert', async () => {
    const { logger } = collectingLogger();
    const pingCheck = vi.fn((_url: string) => Promise.resolve());
    const purge = vi.fn(() => Promise.reject(new Error('purge boom')));
    const config = makeTestConfig({ RETENTION_CHECK_URL: CHECK_URL });

    await expect(runRetention({ config, logger, purge, pingCheck })).rejects.toThrow('purge boom');

    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('does not ping when no check URL is configured', async () => {
    const { logger } = collectingLogger();
    const pingCheck = vi.fn((_url: string) => Promise.resolve());
    const config = makeTestConfig({ RETENTION_CHECK_URL: undefined });

    await runRetention({ config, logger, pingCheck });

    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('a ping failure is logged (sanitized) but does not fail the run', async () => {
    const { lines, logger } = collectingLogger();
    const pingCheck = vi.fn(() => Promise.reject(new Error(`connect ECONNREFUSED ${CHECK_URL}`)));
    const config = makeTestConfig({ RETENTION_CHECK_URL: CHECK_URL });

    await expect(runRetention({ config, logger, pingCheck })).resolves.toBeUndefined();

    const line = lines.find((l) => l.includes('external check ping failed'));
    expect(line).toBeDefined();
    expect(line).toContain('retention-cron');
    expect(line).not.toContain('checks.example.com');
  });
});
