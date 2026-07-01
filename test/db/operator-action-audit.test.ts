import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repositories } from '../../src/db/index.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';

const PATTERN = 'test-audit-%';

/** The review surface's audit trail captures before/after snapshots, and enqueue is
 * idempotent per open call. */
describe.skipIf(!hasTestDb)('operator-action audit', () => {
  let owner!: Pool;
  let app!: Pool;

  async function seedCall(callId: string): Promise<void> {
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'review',
      status: 'held',
    });
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('records an operator action with before/after snapshots', async () => {
    const callId = 'test-audit-1';
    await seedCall(callId);
    const review = await repositories.reviewQueue.enqueueReview(app, {
      callId,
      heldReason: 'classifier_uncertain',
      slaDueAt: new Date('2026-07-02T00:00:00Z'),
    });
    expect(review.held_reason).toBe('classifier_uncertain');
    expect(review.sla_due_at).toBeInstanceOf(Date);

    const before = { call_intent: 'general', urgency: 'routine' };
    const after = { call_intent: 'new_booking', urgency: 'emergency' };
    const action = await repositories.operatorActions.recordOperatorAction(app, {
      reviewQueueId: review.id,
      actor: 'operator@ovio.test',
      action: 'correct_extraction',
      before,
      after,
    });

    expect(action.action).toBe('correct_extraction');
    expect(action.actor).toBe('operator@ovio.test');
    expect(action.before).toEqual(before);
    expect(action.after).toEqual(after);

    const persisted = await repositories.operatorActions.listByReview(app, review.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.before).toEqual(before);
    expect(persisted[0]?.after).toEqual(after);
    expect(persisted[0]?.review_queue_id).toBe(review.id);
  });

  it('enqueueReview is idempotent while the call is open', async () => {
    const callId = 'test-audit-2';
    await seedCall(callId);
    const first = await repositories.reviewQueue.enqueueReview(app, {
      callId,
      heldReason: 'redaction_failed',
      slaDueAt: new Date('2026-07-02T00:00:00Z'),
    });
    const second = await repositories.reviewQueue.enqueueReview(app, {
      callId,
      heldReason: 'redaction_failed',
      slaDueAt: new Date('2026-07-03T00:00:00Z'),
    });
    expect(second.id).toBe(first.id);
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(res.rows[0]?.n).toBe('1');
  });
});
