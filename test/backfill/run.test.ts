import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import type { RecentCall } from '../../src/dialpad/client/index.js';
import { runBackfill, BACKFILL_ADVISORY_LOCK_KEY } from '../../src/backfill/run.js';
import { createPgBackfillInlineIngest } from '../../src/backfill/ingest.js';
import type { BackfillMonitor } from '../../src/heartbeat/index.js';
import { getRun, startRun } from '../../src/db/repositories/backfill-runs-repo.js';
import {
  countRunCalls,
  insertRunCallIfAbsent,
} from '../../src/db/repositories/backfill-run-calls-repo.js';
import { encodeCheckpoint } from '../../src/backfill/checkpoint.js';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** A monitor spy that records lifecycle calls. Terminal signals are async (awaited by runBackfill). */
function spyMonitor(): BackfillMonitor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: () => {
      calls.push('start');
      return Promise.resolve();
    },
    recordProgress: () => calls.push('progress'),
    success: () => {
      calls.push('success');
      return Promise.resolve();
    },
    fail: () => {
      calls.push('fail');
      return Promise.resolve();
    },
    stop: () => calls.push('stop'),
  };
}

/** A single-page metadata list client over a fixed call set. */
function listClient(calls: RecentCall[]): {
  listRecentlyConcludedCalls: () => Promise<{ calls: RecentCall[] }>;
} {
  return { listRecentlyConcludedCalls: () => Promise.resolve({ calls }) };
}

describe.skipIf(!hasTestDb)('runBackfill orchestrator', () => {
  let owner!: Pool;
  let app!: Pool;
  const config = makeTestConfig({ BACKFILL_MAX_CALL_MINUTES: 240, BACKFILL_DRAIN_POLL_MS: 1 });

  const FROM = Date.parse('2022-02-01T00:00:00Z');
  const TO = Date.parse('2022-02-02T00:00:00Z');
  const WINDOW = { fromMs: FROM, toMs: TO };
  const PREFIX = 'bf-run-';

  function call(id: string, startOffset: number): RecentCall {
    return {
      callId: `${PREFIX}${id}`,
      startedAt: FROM + startOffset,
      endedAt: FROM + startOffset + 1000,
    };
  }

  /** Inline ingest whose runCall drives each call straight to `completed` (a pipeline stand-in). */
  function inlineIngestFor(runId: string) {
    return createPgBackfillInlineIngest({
      pool: app,
      runId,
      runCall: async (callId) => {
        await owner.query(`UPDATE call_state SET status = 'completed' WHERE call_id = $1`, [
          callId,
        ]);
      },
    });
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM backfill_run_calls WHERE call_id LIKE $1`, [`${PREFIX}%`]);
    await owner.query(`DELETE FROM dead_letter WHERE call_id LIKE $1`, [`${PREFIX}%`]);
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${PREFIX}%`]);
    await owner.query(`DELETE FROM backfill_runs WHERE window_start = $1 AND window_end = $2`, [
      new Date(FROM),
      new Date(TO),
    ]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('sweeps a fresh window: seeds, tracks, drives to terminal, pings success', async () => {
    const calls = [call('a', 100), call('b', 200)];
    const monitor = spyMonitor();
    const result = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient(calls),
      ingestFor: inlineIngestFor,
      monitor,
      emitCheckpointAlert: () => Promise.resolve(),
    });
    expect(result.seededTotal).toBe(2);
    expect(result.terminalCount).toBe(2);
    expect(await countRunCalls(app, result.runId)).toBe(2);
    expect((await getRun(app, result.runId))?.status).toBe('completed');
    expect(monitor.calls).toContain('start');
    expect(monitor.calls).toContain('success');
    expect(monitor.calls).not.toContain('fail');
  });

  it('re-running a COMPLETED window enqueues nothing new', async () => {
    const calls = [call('a', 100)];
    await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient(calls),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
    });
    // Second run: a fresh run row (completed excluded from resumable); the call is already
    // completed → alreadyInPipeline true → nothing seeded.
    const second = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient(calls),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
    });
    expect(second.seededTotal).toBe(0);
  });

  it('refuses an overlapping run with already_running and does NOT ping start', async () => {
    // Hold the advisory lock on a separate connection.
    const holder = await app.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [BACKFILL_ADVISORY_LOCK_KEY]);
      const monitor = spyMonitor();
      await expect(
        runBackfill({
          pool: app,
          config,
          logger: noopLogger,
          window: WINDOW,
          client: listClient([call('a', 100)]),
          ingestFor: inlineIngestFor,
          monitor,
          emitCheckpointAlert: () => Promise.resolve(),
        }),
      ).rejects.toMatchObject({ reason: 'already_running' });
      expect(monitor.calls).not.toContain('start');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [BACKFILL_ADVISORY_LOCK_KEY]);
      holder.release();
    }
  });

  it('tracks and awaits a RESCUED pre-existing pristine seed (R2 #1)', async () => {
    // Pre-seed a pristine first-stage processing row for an in-window call (no tracking yet).
    const rescued = call('rescue', 150);
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'webhook', 'metadata-pre-filter', 'processing')`,
      [rescued.callId],
    );
    const result = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient([rescued]),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
    });
    expect(result.seededTotal).toBe(1); // the pristine seed was rescued + processed
    const tracked = await owner.query(
      `SELECT 1 FROM backfill_run_calls WHERE backfill_run_id = $1 AND call_id = $2`,
      [result.runId, rescued.callId],
    );
    expect(tracked.rows).toHaveLength(1);
  });

  it('resumes with no gaps/duplicates across the page-boundary watermark (R1 #3)', async () => {
    // Simulate a partial first pass: run A (start+300, done), a pristine seed B at the exact
    // watermark (start+200), watermark = FROM+200, tracked A + B. Resume should skip A (newer),
    // re-ingest B at the boundary (rescue → complete), and process D (start+100, new).
    const a = call('a', 300);
    const b = call('b', 200);
    const d = call('d', 100);
    // A: already completed + tracked (from the simulated first pass).
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'dialpad-backfill', 'metadata-pre-filter', 'completed')`,
      [a.callId],
    );
    // B: pristine seed at the boundary + tracked.
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'dialpad-backfill', 'metadata-pre-filter', 'processing')`,
      [b.callId],
    );
    const run = await startRun(app, {
      windowStart: new Date(FROM),
      windowEnd: new Date(TO),
      status: 'interrupted',
      lastCheckpoint: encodeCheckpoint({
        v: 1,
        phase: 'sweep',
        watermarkStartedAtMs: FROM + 200,
        callsSeen: 2,
        seededTotal: 1,
        terminalCount: 1,
      }),
    });
    await insertRunCallIfAbsent(app, run.id, a.callId);
    await insertRunCallIfAbsent(app, run.id, b.callId);

    const result = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient([a, b, d]),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
      resume: run.id,
    });
    // Same run id reused; all three tracked, none duplicated; B rescued to completed, D processed.
    expect(result.runId).toBe(run.id);
    expect(await countRunCalls(app, run.id)).toBe(3);
    const bStatus = await owner.query<{ status: string }>(
      `SELECT status FROM call_state WHERE call_id = $1`,
      [b.callId],
    );
    expect(bStatus.rows[0]?.status).toBe('completed');
  });

  it('refuses a resumable row when neither --resume nor --restart is given', async () => {
    await startRun(app, {
      windowStart: new Date(FROM),
      windowEnd: new Date(TO),
      status: 'running',
    });
    await expect(
      runBackfill({
        pool: app,
        config,
        logger: noopLogger,
        window: WINDOW,
        client: listClient([call('a', 100)]),
        ingestFor: inlineIngestFor,
        monitor: spyMonitor(),
        emitCheckpointAlert: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ reason: 'resumable_run_exists' });
  });

  it('checkpoint-write failure → BACKFILL_CHECKPOINT_FAILED + failed + clean stop; --resume continues', async () => {
    const calls = [call('a', 100)];
    const alert = vi.fn().mockResolvedValue(undefined);
    const monitor = spyMonitor();
    // Fail the FIRST checkpoint write.
    let n = 0;
    const failingSave = (_runId: string, _json: string): Promise<void> => {
      n += 1;
      return n === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve();
    };
    let firstRunId: string | undefined;
    await expect(
      runBackfill({
        pool: app,
        config,
        logger: noopLogger,
        window: WINDOW,
        client: {
          listRecentlyConcludedCalls: () => {
            // capture nothing; the run id is created before the sweep
            return Promise.resolve({ calls });
          },
        },
        ingestFor: (runId) => {
          firstRunId = runId;
          return inlineIngestFor(runId);
        },
        monitor,
        emitCheckpointAlert: alert,
        saveCheckpoint: failingSave,
      }),
    ).rejects.toMatchObject({ reason: 'checkpoint_failed' });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(monitor.calls).toContain('fail');
    expect(firstRunId).toBeDefined();
    expect((await getRun(app, firstRunId as string))?.status).toBe('failed');

    // --resume continues with a working checkpoint writer; no duplicate run row.
    const resumed = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient(calls),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
      resume: firstRunId as string,
    });
    expect(resumed.runId).toBe(firstRunId);
    expect((await getRun(app, firstRunId as string))?.status).toBe('completed');
    // The call was tracked before the failed first checkpoint; the resume (checkpoint=null) skips it
    // as already-terminal, so the sweep's own seededTotal is 0 — but the reconciled count matches the
    // tracked calls (≥ terminalCount), not a misleading zero.
    expect(resumed.seededTotal).toBe(1);
    expect(resumed.terminalCount).toBe(1);
    expect(resumed.seededTotal).toBeGreaterThanOrEqual(resumed.terminalCount);
  });

  it('refuses --resume when the stored window does not match --from/--to', async () => {
    // A resumable run for a DIFFERENT window than the CLI request.
    const otherFrom = new Date(FROM - 86_400_000);
    const otherTo = new Date(TO - 86_400_000);
    const run = await startRun(app, {
      windowStart: otherFrom,
      windowEnd: otherTo,
      status: 'interrupted',
      lastCheckpoint: encodeCheckpoint({
        v: 1,
        phase: 'sweep',
        watermarkStartedAtMs: FROM,
        callsSeen: 3,
        seededTotal: 3,
        terminalCount: 0,
      }),
    });
    const monitor = spyMonitor();
    await expect(
      runBackfill({
        pool: app,
        config,
        logger: noopLogger,
        window: WINDOW, // mismatched against the run's stored window
        client: listClient([call('a', 100)]),
        ingestFor: inlineIngestFor,
        monitor,
        emitCheckpointAlert: () => Promise.resolve(),
        resume: run.id,
      }),
    ).rejects.toMatchObject({ reason: 'resume_window_mismatch' });
    // No start ping, no ingest, checkpoint untouched (still the original stored one).
    expect(monitor.calls).not.toContain('start');
    expect(await countRunCalls(app, run.id)).toBe(0);
    const after = await getRun(app, run.id);
    expect(after?.status).toBe('interrupted');
    expect(after?.last_checkpoint).not.toBeNull();
    // Clean up the other-window run.
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('refuses --resume --restart-from-scratch on a window mismatch (no reset)', async () => {
    const otherFrom = new Date(FROM - 86_400_000);
    const otherTo = new Date(TO - 86_400_000);
    const run = await startRun(app, {
      windowStart: otherFrom,
      windowEnd: otherTo,
      status: 'failed',
      lastCheckpoint:
        '{"v":1,"phase":"sweep","watermarkStartedAtMs":1,"callsSeen":1,"seededTotal":1,"terminalCount":0}',
    });
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'dialpad-backfill', 'metadata-pre-filter', 'processing')`,
      [`${PREFIX}mismatch`],
    );
    await insertRunCallIfAbsent(app, run.id, `${PREFIX}mismatch`);
    await expect(
      runBackfill({
        pool: app,
        config,
        logger: noopLogger,
        window: WINDOW,
        client: listClient([call('a', 100)]),
        ingestFor: inlineIngestFor,
        monitor: spyMonitor(),
        emitCheckpointAlert: () => Promise.resolve(),
        resume: run.id,
        restartFromScratch: true,
      }),
    ).rejects.toMatchObject({ reason: 'resume_window_mismatch' });
    // resetRun did NOT run: the checkpoint + tracking survive untouched.
    const after = await getRun(app, run.id);
    expect(after?.status).toBe('failed');
    expect(after?.last_checkpoint).not.toBeNull();
    expect(await countRunCalls(app, run.id)).toBe(1);
    await owner.query(`DELETE FROM backfill_run_calls WHERE backfill_run_id = $1`, [run.id]);
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('restart-from-scratch reuses the row, clears checkpoint + tracking (no duplicate row)', async () => {
    const a = call('a', 100);
    const run = await startRun(app, {
      windowStart: new Date(FROM),
      windowEnd: new Date(TO),
      status: 'failed',
      lastCheckpoint: encodeCheckpoint({
        v: 1,
        phase: 'sweep',
        watermarkStartedAtMs: FROM + 500,
        callsSeen: 9,
        seededTotal: 9,
        terminalCount: 0,
      }),
    });
    // Stale tracking rows from the aborted attempt.
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'dialpad-backfill', 'metadata-pre-filter', 'processing')`,
      [`${PREFIX}stale`],
    );
    await insertRunCallIfAbsent(app, run.id, `${PREFIX}stale`);

    const result = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: WINDOW,
      client: listClient([a]),
      ingestFor: inlineIngestFor,
      monitor: spyMonitor(),
      emitCheckpointAlert: () => Promise.resolve(),
      resume: run.id,
      restartFromScratch: true,
    });
    expect(result.runId).toBe(run.id); // reused row
    // Tracking was cleared then repopulated ONLY by the fresh sweep (the stale row is gone; `a` is in).
    const tracked = await owner.query<{ call_id: string }>(
      `SELECT call_id FROM backfill_run_calls WHERE backfill_run_id = $1 ORDER BY call_id`,
      [run.id],
    );
    expect(tracked.rows.map((r) => r.call_id)).toEqual([a.callId]);
    // Exactly one run row for the window (no duplicate).
    const runs = await owner.query(
      `SELECT id FROM backfill_runs WHERE window_start = $1 AND window_end = $2`,
      [new Date(FROM), new Date(TO)],
    );
    expect(runs.rows).toHaveLength(1);
  });
});
