import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-%';

describe.skipIf(!hasTestDb || !hasTestRedis)('retry exhaustion → dead_letter', () => {
  let h!: WorkerHarness;

  beforeAll(async () => {
    await migrate('up');
  });
  beforeEach(() => {
    h = makeWorkerHarness();
  });
  afterEach(async () => {
    // alert_events has no call_id column, so remove this test's alert by its dedup key.
    await h.owner.query('DELETE FROM alert_events WHERE dedup_key LIKE $1', [
      'dead_letter:test-wk-%',
    ]);
    await cleanupCalls(h.owner, PATTERN);
    await h.close();
  });

  it('lands in dead_letter with QUEUE_RETRY_EXHAUSTED and emits one DEAD_LETTER_CREATED alert', async () => {
    const callId = 'test-wk-exhaust';
    await h.seedCall(callId);
    await enqueueCall(h.queue, callId, h.config);

    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      classify: () => Promise.reject(new Error('permanent classify failure')),
    };

    const worker = h.buildWorker(handlers);
    void worker.run();
    try {
      await waitFor(
        async () => {
          const res = await h.owner.query('SELECT 1 FROM dead_letter WHERE call_id = $1', [callId]);
          return (res.rowCount ?? 0) > 0;
        },
        { label: 'dead_letter row created', timeoutMs: 8000 },
      );
    } finally {
      await worker.close();
    }

    // Exactly one dead_letter row, right error code, failed stage identified, no raw message.
    const dl = await h.owner.query(
      'SELECT error_code, root_cause_category, last_error, failure_snapshot FROM dead_letter WHERE call_id = $1',
      [callId],
    );
    expect(dl.rowCount).toBe(1);
    const row = dl.rows[0] as {
      error_code: string;
      root_cause_category: string;
      last_error: string;
      failure_snapshot: Record<string, unknown>;
    };
    expect(row.error_code).toBe('QUEUE_RETRY_EXHAUSTED');
    expect(row.root_cause_category).toBe('QUEUE_RETRY_EXHAUSTED');
    expect(row.failure_snapshot.failed_stage).toBe('classify');
    // Fail-closed: sanitized metadata carries no raw error message.
    expect(row.last_error).not.toMatch(/permanent classify failure/);
    expect(JSON.stringify(row.failure_snapshot)).not.toMatch(/permanent classify failure/);

    // Exactly one actionable alert.
    const alerts = await h.owner.query('SELECT error_code FROM alert_events WHERE dedup_key = $1', [
      `dead_letter:${callId}`,
    ]);
    expect(alerts.rowCount).toBe(1);
    expect((alerts.rows[0] as { error_code: string }).error_code).toBe('DEAD_LETTER_CREATED');

    // The failed stage is also identified in a processing_log failure row.
    const failed = await h.owner.query(
      "SELECT 1 FROM processing_log WHERE call_id = $1 AND outcome = 'failed' AND stage = 'classify'",
      [callId],
    );
    expect(failed.rowCount ?? 0).toBeGreaterThan(0);
  });

  it("dead-letters per the JOB's attempts even when the worker's config differs", async () => {
    // Job enqueued with attempts=2, but the worker (h.config) runs with a higher max (3).
    // Exhaustion must follow the job's own attempts — otherwise a job that outlived a config
    // change would either never dead-letter or dead-letter too early.
    const callId = 'test-wk-exhaust-cfg';
    await h.seedCall(callId);
    await enqueueCall(h.queue, callId, { ...h.config, WORKER_MAX_ATTEMPTS: 2 });
    expect(h.config.WORKER_MAX_ATTEMPTS).toBeGreaterThan(2); // precondition: configs differ

    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      classify: () => Promise.reject(new Error('permanent classify failure')),
    };

    const worker = h.buildWorker(handlers);
    void worker.run();
    try {
      await waitFor(
        async () => {
          const res = await h.owner.query('SELECT 1 FROM dead_letter WHERE call_id = $1', [callId]);
          return (res.rowCount ?? 0) > 0;
        },
        { label: 'dead_letter honoring job attempts', timeoutMs: 8000 },
      );
    } finally {
      await worker.close();
    }

    const dl = await h.owner.query('SELECT failure_snapshot FROM dead_letter WHERE call_id = $1', [
      callId,
    ]);
    expect(dl.rowCount).toBe(1);
    // Dead-lettered on the job's 2nd (final) attempt, not the worker's 3rd.
    expect(
      (dl.rows[0] as { failure_snapshot: { attempts_made: number } }).failure_snapshot
        .attempts_made,
    ).toBe(2);
  });
});
