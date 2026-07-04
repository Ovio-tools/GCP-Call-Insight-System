import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import {
  insertReprocessRequest,
  getReprocessRequestById,
} from '../../src/db/repositories/reprocess-requests-repo.js';
import { drainPendingReprocessRequests } from '../../src/reconciliation/reprocess-drain.js';

/**
 * The reconciliation cron's reprocess-outbox drain (Task 6.2): pending rows enqueued once and
 * marked `sent`; a `call_state` that changed after the insert is `superseded` and not enqueued;
 * a repeated enqueue failure bumps `attempt_count`, stores a sanitized `last_error_code`, leaves
 * the row `pending`, and marks the drain incomplete (`failed > 0`).
 */
describe.skipIf(!hasTestDb)('drainPendingReprocessRequests', () => {
  let owner!: Pool;
  let app!: Pool;
  const PREFIX = 'drain-test-';

  async function seedProcessingCall(
    callId: string,
    stage: string,
  ): Promise<{ reviewId: string; actionId: string }> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', $2, 'processing')
       ON CONFLICT (call_id) DO UPDATE SET current_stage = EXCLUDED.current_stage, status = 'processing'`,
      [callId, stage],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, resolved_at)
       VALUES ($1, 'redaction_failed', 'resolved', now() + interval '1 hour', now()) RETURNING id`,
      [callId],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await owner.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'drain-test', 'reprocess', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [reviewId],
    );
    return { reviewId, actionId: oa.rows[0]!.id };
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM reprocess_requests WHERE call_id LIKE $1`, [`${PREFIX}%`]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
      [`${PREFIX}%`],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [`${PREFIX}%`]);
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${PREFIX}%`]);
  }

  beforeAll(() => {
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('enqueues a pending row once and marks it sent', async () => {
    const callId = `${PREFIX}sent`;
    const { reviewId, actionId } = await seedProcessingCall(callId, 'redact');
    const row = await insertReprocessRequest(app, {
      operatorActionId: actionId,
      callId,
      reviewQueueId: reviewId,
      targetStage: 'redact',
      requestedBy: 'drain-test',
    });

    const calls: { callId: string; targetStage: string }[] = [];
    const result = await drainPendingReprocessRequests(app, {
      enqueue: (r) => {
        calls.push({ callId: r.callId, targetStage: r.targetStage });
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ enqueued: 1, superseded: 0, failed: 0 });
    expect(calls).toEqual([{ callId, targetStage: 'redact' }]);
    const after = await getReprocessRequestById(app, row.id);
    expect(after?.status).toBe('sent');
    expect(after?.sent_at).toBeInstanceOf(Date);
  });

  it('marks superseded and does not enqueue when call_state no longer matches', async () => {
    const callId = `${PREFIX}superseded`;
    const { reviewId, actionId } = await seedProcessingCall(callId, 'redact');
    const row = await insertReprocessRequest(app, {
      operatorActionId: actionId,
      callId,
      reviewQueueId: reviewId,
      targetStage: 'redact',
      requestedBy: 'drain-test',
    });
    // A later recovery moved the call off processing@redact.
    await owner.query(`UPDATE call_state SET current_stage = 'classify' WHERE call_id = $1`, [
      callId,
    ]);

    const calls: string[] = [];
    const result = await drainPendingReprocessRequests(app, {
      enqueue: (r) => {
        calls.push(r.callId);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ enqueued: 0, superseded: 1, failed: 0 });
    expect(calls).toEqual([]);
    const after = await getReprocessRequestById(app, row.id);
    expect(after?.status).toBe('superseded');
  });

  it('bumps attempt_count and leaves pending on enqueue failure (drain incomplete)', async () => {
    const callId = `${PREFIX}fail`;
    const { reviewId, actionId } = await seedProcessingCall(callId, 'redact');
    const row = await insertReprocessRequest(app, {
      operatorActionId: actionId,
      callId,
      reviewQueueId: reviewId,
      targetStage: 'redact',
      requestedBy: 'drain-test',
    });

    const result = await drainPendingReprocessRequests(app, {
      enqueue: () =>
        Promise.reject(Object.assign(new Error('boom'), { code: 'REDIS_UNAVAILABLE' })),
    });

    expect(result.failed).toBe(1);
    expect(result.enqueued).toBe(0);
    const after = await getReprocessRequestById(app, row.id);
    expect(after?.status).toBe('pending');
    expect(after?.attempt_count).toBe(1);
    expect(after?.last_error_code).toBe('REDIS_UNAVAILABLE');
    expect(after?.last_attempted_at).toBeInstanceOf(Date);
  });

  it('a duplicate insert for the same action is rejected (UNIQUE operator_action_id)', async () => {
    const callId = `${PREFIX}dup`;
    const { reviewId, actionId } = await seedProcessingCall(callId, 'redact');
    await insertReprocessRequest(app, {
      operatorActionId: actionId,
      callId,
      reviewQueueId: reviewId,
      targetStage: 'redact',
      requestedBy: 'drain-test',
    });
    await expect(
      insertReprocessRequest(app, {
        operatorActionId: actionId,
        callId,
        reviewQueueId: reviewId,
        targetStage: 'classify',
        requestedBy: 'drain-test',
      }),
    ).rejects.toThrow();
  });
});
