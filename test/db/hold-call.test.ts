import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DalError } from '../../src/db/errors.js';
import {
  getCallState,
  holdCall,
  markTranscriptWaitStarted,
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';

const PATTERN = 'test-hold-%';

describe.skipIf(!hasTestDb)('holdCall + markTranscriptWaitStarted', () => {
  let owner!: Pool;
  let app!: Pool;

  const seed = (callId: string, stage = 'fetch-transcript'): Promise<unknown> =>
    upsertCallState(app, { callId, source: 'test', currentStage: stage, status: 'processing' });

  const reviewRows = async (
    callId: string,
  ): Promise<{ held_reason: string; sla_due_at: Date | null }[]> =>
    (
      await owner.query<{ held_reason: string; sla_due_at: Date | null }>(
        `SELECT held_reason, sla_due_at FROM review_queue WHERE call_id = $1`,
        [callId],
      )
    ).rows;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('atomically writes held status + one review_queue row + one held log row', async () => {
    const callId = 'test-hold-basic';
    await seed(callId);

    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
      logDetail: { waited_ms: 123 },
    });

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held');
    expect(state?.current_stage).toBe('fetch-transcript'); // never advances
    expect(state?.drop_reason).toBeNull(); // biconditional: not skipped ⇒ no drop_reason

    const reviews = await reviewRows(callId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.held_reason).toBe('missing_transcript');
    expect(reviews[0]?.sla_due_at).not.toBeNull();

    const logs = await listByCall(app, callId);
    const held = logs.filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]?.error_code).toBe('DIALPAD_TRANSCRIPT_MISSING');
    expect(held[0]?.detail).toMatchObject({ held_reason: 'missing_transcript', waited_ms: 123 });
  });

  it('persists the full failure_snapshot on the held processing_log row', async () => {
    const callId = 'test-hold-snapshot';
    await seed(callId);

    const snapshot = {
      error_code: 'DIALPAD_TRANSCRIPT_MISSING',
      root_cause_category: 'DIALPAD_TRANSCRIPT_MISSING',
      severity: 'low',
      impact: 'held for review',
      processing_state: 'degraded',
      remediation_now: 'review the held call',
      remediation_fix: 'same as the immediate step',
      data_safe: true,
      calls_state: 'held',
      owner: 'OVIO on-call',
      runbook_ref: 'runbook#dialpad-transcript-missing',
      context: { call_id: callId, stage: 'fetch-transcript' },
    };

    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
      failureSnapshot: snapshot,
    });

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]?.failure_snapshot).toEqual(snapshot);
  });

  it('leaves failure_snapshot null on a held row when none is supplied', async () => {
    const callId = 'test-hold-nosnapshot';
    await seed(callId);

    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'classifier_uncertain',
    });

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held[0]?.failure_snapshot).toBeNull();
  });

  it('is idempotent under a concurrent/repeated hold (second call is stale, no duplicate rows)', async () => {
    const callId = 'test-hold-idem';
    await seed(callId);

    await holdCall(app, { callId, atStage: 'fetch-transcript', heldReason: 'missing_transcript' });
    await expect(
      holdCall(app, { callId, atStage: 'fetch-transcript', heldReason: 'missing_transcript' }),
    ).rejects.toBeInstanceOf(DalError);

    expect(await reviewRows(callId)).toHaveLength(1);
    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
  });

  it('markTranscriptWaitStarted stamps once and COALESCEs on repeat', async () => {
    const callId = 'test-hold-wait';
    await seed(callId);

    const first = await markTranscriptWaitStarted(app, callId);
    expect(first).toBeInstanceOf(Date);

    const second = await markTranscriptWaitStarted(app, callId);
    expect(second?.getTime()).toBe(first?.getTime()); // window never resets
  });

  it('accepts held_reason=classified_spam (Task 5.1 classify routing)', async () => {
    const callId = 'test-hold-spam';
    await seed(callId);

    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'classified_spam',
    });

    const reviews = await reviewRows(callId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.held_reason).toBe('classified_spam');
  });
});
