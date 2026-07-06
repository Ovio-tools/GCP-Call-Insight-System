import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { hasTestDb, makePool } from './_pg.js';
import { makeAppPool } from './_dal.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { listAcceptedExamples } from '../../src/db/repositories/labeled-examples-repo.js';
import { markSample, seedLabeledBaseline } from '../../src/sample-validation/index.js';

const logger = pino({ level: 'silent' });

/**
 * Marking a validation sample correct/wrong (Task 11.1) persists a review + operator-action audit
 * row, and `seedLabeledBaseline` mines it into the Phase 6.3 labeled corpus via the SAME
 * `syncLabeledExamples` derivation the reconciliation cron uses — no duplicated label logic.
 */
describe.skipIf(!hasTestDb)('sample-validation marking → labeled baseline (Task 11.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'sv-mark-call';

  async function seedProcessedCall(): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'mark-retention-eligible', 'completed')
       ON CONFLICT (call_id) DO NOTHING`,
      [CALL],
    );
    await upsertCleanTranscript(app, {
      callId: CALL,
      redactedText: 'Customer [NAME_1] wants a water heater replaced next week.',
      redactionRiskScore: 0.05,
      redactionReasons: [],
    });
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM model_invocations WHERE call_id = $1`, [CALL]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN (SELECT id FROM review_queue WHERE call_id = $1)`,
      [CALL],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM clean_transcripts WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
  }

  beforeAll(() => {
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await cleanup();
    await seedProcessedCall();
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('marks a classify sample and flows the asserted bucket into the labeled baseline', async () => {
    const { reviewQueueId, operatorActionId } = await markSample(app, {
      callId: CALL,
      taskType: 'classify',
      verdict: 'correct',
      classifyBucket: 'customer',
      actor: 'validator-1',
      notes: 'clearly a customer booking',
    });
    expect(reviewQueueId).toBeTruthy();
    expect(operatorActionId).toBeTruthy();

    const summary = await seedLabeledBaseline(app, { denyTerms: [], logger });
    expect(summary.accepted).toBe(1);

    const examples = await listAcceptedExamples(owner);
    const mine = examples.filter((e) => e.call_id === CALL);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.task_type).toBe('classify');
    expect(mine[0]!.expected_output).toEqual({ bucket: 'customer' });
    expect(mine[0]!.redacted_input).toContain('[NAME_1]');
    // Reviewer notes never enter the durable labeled asset.
    expect(mine[0]!.redacted_input).not.toContain('clearly a customer booking');
  });

  it('maps a "wrong" classify verdict to the reviewer-asserted bucket (spam)', async () => {
    await markSample(app, {
      callId: CALL,
      taskType: 'classify',
      verdict: 'wrong',
      classifyBucket: 'spam',
      actor: 'validator-1',
    });
    await seedLabeledBaseline(app, { denyTerms: [], logger });

    const mine = (await listAcceptedExamples(owner)).filter((e) => e.call_id === CALL);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.expected_output).toEqual({ bucket: 'spam' });
  });

  it('marks an extract sample with corrected controlled fields into the labeled baseline', async () => {
    await markSample(app, {
      callId: CALL,
      taskType: 'extract',
      verdict: 'wrong',
      extractEnums: {
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'routine',
        sentiment: 'neutral',
      },
      actor: 'validator-2',
      notes: 'model missed the intent',
    });
    const summary = await seedLabeledBaseline(app, { denyTerms: [], logger });
    expect(summary.accepted).toBe(1);

    const mine = (await listAcceptedExamples(owner)).filter((e) => e.call_id === CALL);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.task_type).toBe('extract');
    expect(mine[0]!.expected_output).toEqual({
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
    });
  });

  it('persists the reviewer verdict + notes on the operator-action audit row', async () => {
    await markSample(app, {
      callId: CALL,
      taskType: 'classify',
      verdict: 'wrong',
      classifyBucket: 'non-customer',
      actor: 'validator-3',
      notes: 'internal call',
    });
    const rows = await owner.query<{
      action: string;
      after: { reviewer_verdict?: string; reviewer_notes?: string };
    }>(
      `SELECT oa.action, oa.after FROM operator_actions oa
       JOIN review_queue rq ON rq.id = oa.review_queue_id WHERE rq.call_id = $1`,
      [CALL],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.action).toBe('mark_non_customer');
    expect(rows.rows[0]!.after.reviewer_verdict).toBe('wrong');
    expect(rows.rows[0]!.after.reviewer_notes).toBe('internal call');
  });

  it('seeds a TERMINAL (resolved) review row, never an active one', async () => {
    const { reviewQueueId } = await markSample(app, {
      callId: CALL,
      taskType: 'classify',
      verdict: 'correct',
      classifyBucket: 'customer',
      actor: 'validator-1',
    });
    const rows = await owner.query<{ status: string }>(
      `SELECT status FROM review_queue WHERE id = $1`,
      [reviewQueueId],
    );
    // A resolved row is invisible to the stalled-review scan and outside the active partial
    // unique index, so validation marks cannot pollute operations or emit fake REVIEW_QUEUE_STALLED.
    expect(rows.rows[0]!.status).toBe('resolved');
    // ...yet it is still mined into the labeled baseline.
    await seedLabeledBaseline(app, { denyTerms: [], logger });
    expect((await listAcceptedExamples(owner)).filter((e) => e.call_id === CALL)).toHaveLength(1);
  });

  it('does not collide with (or resolve) a real active review for the same call', async () => {
    // A genuine operational hold: an ACTIVE review row exists for the call.
    await owner.query(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at, status)
       VALUES ($1, 'classifier_uncertain', now() + interval '1 hour', 'open')`,
      [CALL],
    );
    await markSample(app, {
      callId: CALL,
      taskType: 'classify',
      verdict: 'wrong',
      classifyBucket: 'spam',
      actor: 'validator-1',
    });
    // The real active review is untouched; the mark added its own terminal row.
    const active = await owner.query(
      `SELECT 1 FROM review_queue WHERE call_id = $1 AND status IN ('open','in_review')`,
      [CALL],
    );
    expect(active.rows).toHaveLength(1);
    const resolved = await owner.query(
      `SELECT 1 FROM review_queue WHERE call_id = $1 AND status = 'resolved'`,
      [CALL],
    );
    expect(resolved.rows).toHaveLength(1);
  });

  it('refuses a reviewer note that carries residual PII (never stored)', async () => {
    await expect(
      markSample(app, {
        callId: CALL,
        taskType: 'classify',
        verdict: 'wrong',
        classifyBucket: 'non-customer',
        actor: 'validator-1',
        notes: 'call the customer back on 415-555-0199',
      }),
    ).rejects.toThrow();
    // Nothing was written for the refused mark.
    const rows = await owner.query(`SELECT 1 FROM review_queue WHERE call_id = $1`, [CALL]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses a classify mark without an asserted bucket, and an extract mark without enums', async () => {
    await expect(
      markSample(app, { callId: CALL, taskType: 'classify', verdict: 'correct', actor: 'v' }),
    ).rejects.toThrow();
    await expect(
      markSample(app, { callId: CALL, taskType: 'extract', verdict: 'wrong', actor: 'v' }),
    ).rejects.toThrow();
  });
});
