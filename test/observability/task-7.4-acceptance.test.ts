import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AlertEventRow } from '../../src/db/schemas/alert-events.js';
import {
  createFailure,
  failureSnapshot,
  renderAlertEventText,
} from '../../src/failure-model/index.js';
import { recordAlert } from '../../src/db/repositories/alert-events-repo.js';
import { recordDeadLetter } from '../../src/db/repositories/dead-letter-repo.js';
import { appendLog, listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { runPipeline } from '../_run-pipeline.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

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
].sort();

const hasAllSnapshotFields = (snap: Record<string, unknown>): boolean =>
  FULL_SNAPSHOT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(snap, k));

// --- Rendered alert text reads as its specific failure, never "unknown" (no DB needed). ---
describe('rendered alert text maps to the specific failure', () => {
  const rowFor = (code: Parameters<typeof createFailure>[0]): AlertEventRow => {
    const f = createFailure(code, { processingState: 'degraded', context: {} });
    return {
      id: '00000000-0000-0000-0000-000000000000',
      error_code: f.error_code,
      root_cause_category: f.root_cause_category,
      severity: f.severity,
      dedup_key: `${f.error_code}:global`,
      acknowledged_at: null,
      created_at: new Date('2026-07-03T00:00:00Z'),
      failure_snapshot: failureSnapshot(f),
    } as unknown as AlertEventRow;
  };
  const opts = { environment: 'production', now: new Date('2026-07-03T00:00:00Z') };

  it('a Dialpad 429 reads as rate-limited and recommends backoff, not "unknown error"', () => {
    const text = renderAlertEventText(rowFor('DIALPAD_RATE_LIMITED'), opts);
    expect(text).toContain('DIALPAD_RATE_LIMITED');
    expect(text.toLowerCase()).toMatch(/back off|rate-limit/);
    expect(text.toLowerCase()).not.toContain('unknown');
  });

  it('a malformed model response reads as a schema-validation failure', () => {
    const text = renderAlertEventText(rowFor('MODEL_MALFORMED_RESPONSE'), opts);
    expect(text).toContain('MODEL_MALFORMED_RESPONSE');
    expect(text.toLowerCase()).toMatch(/schema/);
    expect(text.toLowerCase()).not.toContain('unknown');
  });
});

describe.skipIf(!hasTestDb)('Task 7.4 audit trail + persistence', () => {
  let owner!: Pool;
  let app!: Pool;
  const PATTERN = 'test-obs-%';

  const seed = (callId: string, stage = 'metadata-pre-filter'): Promise<unknown> =>
    upsertCallState(app, { callId, source: 'test', currentStage: stage, status: 'processing' });

  const capture = (): { lines: string[]; logger: ReturnType<typeof createRootLogger> } => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb): void {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(`DELETE FROM alert_events WHERE dedup_key LIKE 'MODEL_MALFORMED_RESPONSE:%'`);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('traces a call end to end by call_id through processing_log with start + success semantics', async () => {
    const callId = 'test-obs-trace';
    await seed(callId);
    const { lines, logger } = capture();

    await runPipeline(app, callId, logger, defaultStageHandlers);

    // Audit trail: one completed row per stage, all carrying the same call_id, in stage order.
    const rows = await listByCall(app, callId);
    expect(rows.every((r) => r.call_id === callId)).toBe(true);
    const completed = rows.filter((r) => r.outcome === 'completed').map((r) => r.stage);
    expect(completed).toEqual([
      'metadata-pre-filter',
      'fetch-transcript',
      'transcript-availability',
      'redact',
      'classify',
      'extract',
      'verbatim-pii-scan',
      'store',
      'mark-retention-eligible',
    ]);

    // Structured log: a start line and a success end line for the first stage. This uses a ROOT
    // logger (no call-child binding), so every stage line must still carry call_id from the
    // stage-log helper itself — the Task 7.4 traceability contract cannot depend on the caller.
    const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const starts = recs.filter((r) => r.event === 'stage_start');
    const successes = recs.filter((r) => r.event === 'stage_end' && r.outcome === 'completed');
    expect(starts.some((r) => r.stage === 'metadata-pre-filter')).toBe(true);
    expect(successes.length).toBe(9);
    for (const r of [...starts, ...successes]) {
      expect(r.call_id).toBe(callId);
    }
    // Log lines carry only allowlisted structured fields (stage/event/outcome/duration_ms) —
    // no content field name ever appears. (The logger's assertNoContentFields hook is the guard;
    // the dedicated privacy suites assert no seeded PII across logs/rows.)
    for (const r of recs) {
      expect(r).not.toHaveProperty('customer_language');
      expect(r).not.toHaveProperty('call_id_value');
    }
  });

  it('records a failure (held) row with the full snapshot + a warn-level failure log line', async () => {
    const callId = 'test-obs-hold';
    await seed(callId, 'classify');
    const { lines, logger } = capture();

    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      classify: () =>
        Promise.resolve({
          action: 'hold' as const,
          reason: 'malformed_model_output' as const,
          errorCode: 'MODEL_MALFORMED_RESPONSE' as const,
        }),
    };
    await runPipeline(app, callId, logger, handlers);

    const held = (await listByCall(app, callId)).filter((r) => r.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]?.error_code).toBe('MODEL_MALFORMED_RESPONSE');
    expect(hasAllSnapshotFields(held[0]?.failure_snapshot as Record<string, unknown>)).toBe(true);

    const failLine = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === 'stage_end' && r.outcome === 'held');
    expect(failLine).toMatchObject({
      call_id: callId,
      stage: 'classify',
      error_code: 'MODEL_MALFORMED_RESPONSE',
      level: 40,
    });
  });

  it('writes the SAME full snapshot schema to alert_events, processing_log, and dead_letter', async () => {
    const callId = 'test-obs-sinks';
    await seed(callId, 'classify');
    const failure = createFailure('MODEL_MALFORMED_RESPONSE', {
      processingState: 'continuing',
      context: { call_id: callId, stage: 'classify' },
    });
    const snap = failureSnapshot(failure);

    await recordAlert(owner, {
      errorCode: failure.error_code,
      rootCauseCategory: failure.root_cause_category,
      severity: failure.severity,
      dedupKey: `MODEL_MALFORMED_RESPONSE:call_id:${callId}`,
      failureSnapshot: snap,
    });
    await appendLog(owner, {
      callId,
      stage: 'classify',
      outcome: 'held',
      errorCode: failure.error_code,
      failureSnapshot: snap,
    });
    await recordDeadLetter(owner, {
      callId,
      jobPayload: { callId },
      errorCode: failure.error_code,
      rootCauseCategory: failure.root_cause_category,
      lastError: 'Stage classify failed: ModelError',
      failureSnapshot: snap,
    });

    const alert = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
      `SELECT failure_snapshot FROM alert_events WHERE dedup_key = $1`,
      [`MODEL_MALFORMED_RESPONSE:call_id:${callId}`],
    );
    const log = (await listByCall(app, callId)).filter((r) => r.outcome === 'held')[0];
    const dl = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
      `SELECT failure_snapshot FROM dead_letter WHERE call_id = $1`,
      [callId],
    );

    for (const s of [
      alert.rows[0]?.failure_snapshot,
      log?.failure_snapshot as Record<string, unknown>,
      dl.rows[0]?.failure_snapshot,
    ]) {
      expect(Object.keys(s ?? {}).sort()).toEqual(FULL_SNAPSHOT_KEYS);
    }
  });

  it('collapses repeated identical failures to ONE alert while preserving every audit row', async () => {
    const callId = 'test-obs-dedup';
    await seed(callId, 'classify');
    const failure = createFailure('MODEL_MALFORMED_RESPONSE', {
      processingState: 'continuing',
      context: { call_id: callId, stage: 'classify' },
    });
    const alertInput = {
      errorCode: failure.error_code,
      rootCauseCategory: failure.root_cause_category,
      severity: failure.severity,
      dedupKey: `MODEL_MALFORMED_RESPONSE:call_id:${callId}`,
      failureSnapshot: failureSnapshot(failure),
    };

    // Same failure recorded three times: alert dedups to one; every audit row is kept.
    for (let i = 0; i < 3; i++) {
      await recordAlert(owner, alertInput);
      await appendLog(owner, {
        callId,
        stage: 'classify',
        outcome: 'failed',
        errorCode: failure.error_code,
        failureSnapshot: failureSnapshot(failure),
      });
    }

    const alerts = await owner.query(`SELECT 1 FROM alert_events WHERE dedup_key = $1`, [
      alertInput.dedupKey,
    ]);
    expect(alerts.rowCount).toBe(1);
    const audit = (await listByCall(app, callId)).filter((r) => r.outcome === 'failed');
    expect(audit).toHaveLength(3);
  });
});
