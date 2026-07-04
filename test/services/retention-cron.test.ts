import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { runRetentionService } from '../../src/services/retention-cron.js';
import { RetentionPurgeError } from '../../src/retention/purge.js';
import type { PurgeReport } from '../../src/retention/purge.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';

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

const okReport: PurgeReport = { dryRun: false, actions: [], groupCounts: [] };

describe.skipIf(!hasTestDb)('runRetentionService (Task 8.1)', () => {
  let owner!: Pool;
  let appPool!: Pool;
  let purgePool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    appPool = makeAppPool();
    purgePool = makeAppPool(); // not exercised when purge is injected
  });
  afterEach(async () => {
    await owner.query(`DELETE FROM alert_events WHERE error_code = 'RETENTION_PURGE_FAILED'`);
  });
  afterAll(async () => {
    await owner.end();
    await appPool.end();
    await purgePool.end();
  });

  it('pings the check exactly once after a successful purge; no alert recorded', async () => {
    const { logger } = collectingLogger();
    const pingCheck = vi.fn((_url: string) => Promise.resolve());
    const purge = vi.fn(() => Promise.resolve(okReport));
    const config = makeTestConfig({ RETENTION_CHECK_URL: CHECK_URL });

    await runRetentionService({ config, logger, purgePool, appPool, purge, pingCheck });

    expect(purge).toHaveBeenCalledTimes(1);
    expect(pingCheck).toHaveBeenCalledTimes(1);
    const alerts = await owner.query(`SELECT 1 FROM alert_events WHERE error_code = 'RETENTION_PURGE_FAILED'`);
    expect(alerts.rowCount).toBe(0);
  });

  it('on purge failure: rejects, withholds the ping, records a PII-free RETENTION_PURGE_FAILED alert', async () => {
    const { lines, logger } = collectingLogger();
    const pingCheck = vi.fn((_url: string) => Promise.resolve());
    const config = makeTestConfig({ RETENTION_CHECK_URL: CHECK_URL });
    const boom = new RetentionPurgeError(
      { group: 'RAW', table: 'raw_transcripts', action: 'hard_delete', dry_run: false, sqlstate: 'XX000' },
      new Error('SECRET_TRANSCRIPT boom'),
    );
    const purge = vi.fn(() => Promise.reject(boom));

    await expect(
      runRetentionService({ config, logger, purgePool, appPool, purge, pingCheck }),
    ).rejects.toBe(boom);

    expect(pingCheck).not.toHaveBeenCalled();

    // The alert is recorded via the app_role pool.
    const alert = await owner.query<{ failure_snapshot: unknown; root_cause_category: string }>(
      `SELECT failure_snapshot, root_cause_category FROM alert_events WHERE error_code = 'RETENTION_PURGE_FAILED'`,
    );
    expect(alert.rowCount).toBe(1);
    expect(alert.rows[0]!.root_cause_category).toBe('RETENTION_PURGE_FAILED');
    const snapshot = JSON.stringify(alert.rows[0]!.failure_snapshot);
    expect(snapshot).toContain('retention-cron'); // component
    // No PII / raw error text leaks into the persisted alert.
    expect(snapshot).not.toContain('SECRET_TRANSCRIPT');

    // The granular actionable diagnostic is emitted on the fatal log line (PII-free).
    const fatal = lines.find((l) => l.includes('retention purge failed'));
    expect(fatal).toBeDefined();
    expect(fatal).toContain('raw_transcripts');
    expect(fatal).toContain('hard_delete');
    expect(fatal).toContain('XX000');
    expect(fatal).not.toContain('SECRET_TRANSCRIPT');
  });
});
