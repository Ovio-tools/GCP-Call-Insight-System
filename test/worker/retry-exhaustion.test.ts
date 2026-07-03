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
    // alert_events has no call_id column, so remove this test's alert by its dedup key. The
    // dead-letter alert now deduplicates via the shared failure-model key (DEAD_LETTER_CREATED
    // scoped by call_id), not the old bespoke `dead_letter:` prefix.
    await h.owner.query('DELETE FROM alert_events WHERE dedup_key LIKE $1', [
      'DEAD_LETTER_CREATED:call_id:test-wk-%',
    ]);
    await cleanupCalls(h.owner, PATTERN);
    await h.close();
  });

  /** The §4 fields every persisted failure_snapshot must carry (Task 7.4). */
  const FULL_SNAPSHOT_KEYS = [
    'error_code',
    'root_cause_category',
    'severity',
    'impact',
    'processing_state',
    'remediation_now',
    'remediation_fix',
    'data_safe',
    'calls_state',
    'owner',
    'runbook_ref',
    'context',
  ];

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
    // The full §4 snapshot is persisted, so the dead-letter row is explainable after the alert.
    expect(Object.keys(row.failure_snapshot).sort()).toEqual([...FULL_SNAPSHOT_KEYS].sort());
    expect(row.failure_snapshot.error_code).toBe('QUEUE_RETRY_EXHAUSTED');
    expect(row.failure_snapshot.runbook_ref).toBe('runbook#queue-retry-exhausted');
    // The failed stage is carried in the sanitized context (allowlisted key).
    expect(row.failure_snapshot.context).toMatchObject({ stage: 'classify', call_id: callId });
    // Fail-closed: neither the sanitized last_error nor the snapshot carries the raw message.
    expect(row.last_error).not.toMatch(/permanent classify failure/);
    expect(JSON.stringify(row.failure_snapshot)).not.toMatch(/permanent classify failure/);

    // Exactly one actionable alert, deduped via the shared failure-model key.
    const alerts = await h.owner.query(
      'SELECT error_code, failure_snapshot FROM alert_events WHERE dedup_key = $1',
      [`DEAD_LETTER_CREATED:call_id:${callId}`],
    );
    expect(alerts.rowCount).toBe(1);
    const alertRow = alerts.rows[0] as {
      error_code: string;
      failure_snapshot: Record<string, unknown>;
    };
    expect(alertRow.error_code).toBe('DEAD_LETTER_CREATED');
    expect(Object.keys(alertRow.failure_snapshot).sort()).toEqual([...FULL_SNAPSHOT_KEYS].sort());

    // The failed stage is identified in a processing_log failure row, which carries the full
    // QUEUE_RETRY_EXHAUSTED snapshot and the sanitized diagnostic in `detail`.
    const failed = await h.owner.query(
      "SELECT detail, failure_snapshot FROM processing_log WHERE call_id = $1 AND outcome = 'failed' AND stage = 'classify' AND error_code = 'QUEUE_RETRY_EXHAUSTED'",
      [callId],
    );
    expect(failed.rowCount ?? 0).toBeGreaterThan(0);
    const failedRow = failed.rows[0] as {
      detail: Record<string, unknown>;
      failure_snapshot: Record<string, unknown>;
    };
    expect(Object.keys(failedRow.failure_snapshot).sort()).toEqual([...FULL_SNAPSHOT_KEYS].sort());
    expect(failedRow.detail).toMatchObject({ failed_stage: 'classify' });
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

    const dl = await h.owner.query('SELECT 1 FROM dead_letter WHERE call_id = $1', [callId]);
    expect(dl.rowCount).toBe(1);
    // Dead-lettered on the job's 2nd (final) attempt, not the worker's 3rd. The attempt count
    // lives in the sanitized diagnostic `detail` of the exhausted processing_log failure row.
    const failed = await h.owner.query(
      "SELECT detail FROM processing_log WHERE call_id = $1 AND outcome = 'failed' AND error_code = 'QUEUE_RETRY_EXHAUSTED'",
      [callId],
    );
    expect(failed.rowCount).toBe(1);
    expect((failed.rows[0] as { detail: { attempts_made: number } }).detail.attempts_made).toBe(2);
  });
});
