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
import { HELD_REASON } from '../../src/db/enums.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';
import { DEFAULT_REVIEW_SLA_MINUTES_BY_REASON } from '../_config.js';

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
      slaMinutes: 60,
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
      slaMinutes: 60,
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
      slaMinutes: 60,
    });

    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held[0]?.failure_snapshot).toBeNull();
  });

  it('is idempotent under a concurrent/repeated hold (second call is stale, no duplicate rows)', async () => {
    const callId = 'test-hold-idem';
    await seed(callId);

    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      slaMinutes: 60,
    });
    await expect(
      holdCall(app, {
        callId,
        atStage: 'fetch-transcript',
        heldReason: 'missing_transcript',
        slaMinutes: 60,
      }),
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
      slaMinutes: 1440,
    });

    const reviews = await reviewRows(callId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.held_reason).toBe('classified_spam');
  });

  it('writes one active row per held_reason with sla_due_at = created_at + slaMinutes exactly', async () => {
    // Plan test 1: drive holdCall for every HELD_REASON; the SLA is computed off the tx clock,
    // so sla_due_at - created_at is exactly slaMinutes (both use the same now()).
    for (const reason of HELD_REASON) {
      const callId = `test-hold-sla-${reason}`;
      await seed(callId);
      const minutes = DEFAULT_REVIEW_SLA_MINUTES_BY_REASON[reason];

      await holdCall(app, {
        callId,
        atStage: 'fetch-transcript',
        heldReason: reason,
        slaMinutes: minutes,
      });

      const rows = (
        await owner.query<{
          held_reason: string;
          status: string;
          sla_due_at: Date;
          created_at: Date;
        }>(
          `SELECT held_reason, status, sla_due_at, created_at FROM review_queue WHERE call_id = $1`,
          [callId],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('open');
      expect(rows[0]?.held_reason).toBe(reason);
      const delta =
        new Date(rows[0]!.sla_due_at).getTime() - new Date(rows[0]!.created_at).getTime();
      expect(delta).toBe(minutes * 60_000);
    }

    // emergency_review is the strict minimum SLA across all reasons.
    const emergency = DEFAULT_REVIEW_SLA_MINUTES_BY_REASON.emergency_review;
    for (const reason of HELD_REASON) {
      if (reason === 'emergency_review') continue;
      expect(DEFAULT_REVIEW_SLA_MINUTES_BY_REASON[reason]).toBeGreaterThan(emergency);
    }
  });

  it('collapses two concurrent holds to exactly one active row (plan test 2)', async () => {
    const callId = 'test-hold-concurrent';
    await seed(callId);

    const results = await Promise.allSettled([
      holdCall(app, {
        callId,
        atStage: 'fetch-transcript',
        heldReason: 'missing_transcript',
        slaMinutes: 60,
      }),
      holdCall(app, {
        callId,
        atStage: 'fetch-transcript',
        heldReason: 'missing_transcript',
        slaMinutes: 60,
      }),
    ]);

    // The status='processing' guard lets exactly one win; the other is stale.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await reviewRows(callId)).toHaveLength(1);
  });

  it('a same-reason re-hold over an existing active row is a benign no-op (plan test 3)', async () => {
    const callId = 'test-hold-samereason';
    await seed(callId);
    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      slaMinutes: 60,
    });

    // Reset call_state to processing so the second hold reaches the review-row conflict path
    // (the call_state guard would otherwise reject it as stale first).
    await owner.query(`UPDATE call_state SET status = 'processing' WHERE call_id = $1`, [callId]);
    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      slaMinutes: 90,
    });

    // Still exactly one active row (DO NOTHING kept the original), and each attempt logged.
    const rows = await reviewRows(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.held_reason).toBe('missing_transcript');
    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(2);
  });

  it('a conflicting-reason re-hold throws an invariant error and rolls back (plan test 3)', async () => {
    const callId = 'test-hold-conflict';
    await seed(callId);
    await holdCall(app, {
      callId,
      atStage: 'fetch-transcript',
      heldReason: 'missing_transcript',
      slaMinutes: 60,
    });

    await owner.query(`UPDATE call_state SET status = 'processing' WHERE call_id = $1`, [callId]);
    await expect(
      holdCall(app, {
        callId,
        atStage: 'fetch-transcript',
        heldReason: 'redaction_failed',
        slaMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: 'DAL_REVIEW_INVARIANT' });

    // Rolled back: one active row, still the original reason, no second held log row.
    const rows = await reviewRows(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.held_reason).toBe('missing_transcript');
    const held = (await listByCall(app, callId)).filter((l) => l.outcome === 'held');
    expect(held).toHaveLength(1);
  });
});
