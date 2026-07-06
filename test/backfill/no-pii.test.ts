import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import { BackfillError } from '../../src/backfill/errors.js';
import { HeartbeatPingError, sanitizePingError } from '../../src/heartbeat/index.js';
import { runBackfill } from '../../src/backfill/run.js';
import { createPgBackfillInlineIngest } from '../../src/backfill/ingest.js';
import type { BackfillMonitor } from '../../src/heartbeat/index.js';
import type { RecentCall } from '../../src/dialpad/client/index.js';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;
const noopMonitor: BackfillMonitor = {
  start: () => Promise.resolve(),
  recordProgress: () => undefined,
  success: () => Promise.resolve(),
  fail: () => Promise.resolve(),
  stop: () => undefined,
};

describe('BackfillError context is sanitized', () => {
  it('carries only sanitized identifiers (ids, env, gate constants) — never content', () => {
    const err = new BackfillError('missing_consent_gates', 'blocked', {
      missing: ['dialpad_recording_consent'],
    });
    // Every context value is a string or string[] — no objects/PII could be smuggled by the type.
    for (const v of Object.values(err.context)) {
      expect(typeof v === 'string' || Array.isArray(v)).toBe(true);
    }
  });
});

describe('ping errors are sanitized (URL never leaks)', () => {
  it('reduces an arbitrary throwable (whose message could embed the URL) to a class token', () => {
    const withUrl = new Error('connect ECONNREFUSED https://secret.example.com/ping/abc123');
    expect(sanitizePingError(withUrl)).not.toContain('secret.example.com');
    // A trusted HeartbeatPingError message (URL-free by construction) passes through.
    expect(sanitizePingError(new HeartbeatPingError('external check returned status 500'))).toBe(
      'external check returned status 500',
    );
  });
});

describe.skipIf(!hasTestDb)('BACKFILL_CHECKPOINT_FAILED alert context is allowlisted', () => {
  let owner!: Pool;
  let app!: Pool;
  const PREFIX = 'bf-nopii-';
  const config = makeTestConfig({ BACKFILL_DRAIN_POLL_MS: 1 });
  const FROM = Date.parse('2024-04-01T00:00:00Z');
  const TO = Date.parse('2024-04-02T00:00:00Z');

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanupCalls(owner, `${PREFIX}%`);
  });
  afterAll(async () => {
    await cleanupCalls(owner, `${PREFIX}%`);
    await owner.query(`DELETE FROM backfill_runs WHERE window_start = $1 AND window_end = $2`, [
      new Date(FROM),
      new Date(TO),
    ]);
    await owner.end();
    await app.end();
  });

  it('the alert context carries only component / environment / job_id / phase', async () => {
    const call: RecentCall = { callId: `${PREFIX}1`, startedAt: FROM + 100, endedAt: FROM + 200 };
    const alert = vi.fn().mockResolvedValue(undefined);
    await expect(
      runBackfill({
        pool: app,
        config,
        logger: noopLogger,
        window: { fromMs: FROM, toMs: TO },
        client: { listRecentlyConcludedCalls: () => Promise.resolve({ calls: [call] }) },
        ingestFor: (runId) =>
          createPgBackfillInlineIngest({
            pool: app,
            runId,
            runCall: async (id) => {
              await owner.query(`UPDATE call_state SET status = 'completed' WHERE call_id = $1`, [
                id,
              ]);
            },
          }),
        monitor: noopMonitor,
        emitCheckpointAlert: alert,
        saveCheckpoint: () => Promise.reject(new Error('disk full: /var/data/secret')),
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_failed' });

    expect(alert).toHaveBeenCalledTimes(1);
    const ctx = alert.mock.calls[0]![0] as Record<string, string>;
    expect(Object.keys(ctx).sort()).toEqual(['component', 'environment', 'job_id', 'phase']);
    expect(ctx.component).toBe('backfill');
    // No PII / no raw error message (the pg detail path) leaked into the alert context.
    expect(JSON.stringify(ctx)).not.toContain('secret');
  });
});
