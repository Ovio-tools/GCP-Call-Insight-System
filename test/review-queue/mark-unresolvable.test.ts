import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  getCallState,
  holdCall,
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
import {
  getReview,
  hasActiveReviewForCall,
  hasTerminalReviewForCall,
  markUnresolvable,
  markUnresolvableByReviewId,
} from '../../src/db/repositories/review-queue-repo.js';
import { listByReview } from '../../src/db/repositories/operator-actions-repo.js';
import { withTransaction } from '../../src/db/sql.js';
import type { HeldReason } from '../../src/db/enums.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-unres-%';
const ACTIVE_UNIQUE_IDX = 'review_queue_one_active_per_call';

describe.skipIf(!hasTestDb)('markUnresolvable (Task 6.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  /** Seed a processing call at `redact` and hold it; returns the active review id. */
  async function seedHeld(
    callId: string,
    reason: HeldReason = 'redaction_failed',
  ): Promise<string> {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'redact',
      status: 'processing',
    });
    await holdCall(app, { callId, atStage: 'redact', heldReason: reason, slaMinutes: 60 });
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM review_queue WHERE call_id = $1 AND status IN ('open', 'in_review')`,
      [callId],
    );
    return rows[0]!.id;
  }

  const activeCount = async (callId: string): Promise<number> =>
    (
      await owner.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM review_queue WHERE call_id = $1 AND status IN ('open','in_review')`,
        [callId],
      )
    ).rows[0]!.c;

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

  it('moves review_queue → unresolvable AND call_state → review_closed atomically, with an audit row', async () => {
    const callId = 'test-unres-basic';
    const reviewId = await seedHeld(callId);

    await markUnresolvable(app, callId, 'alice');

    const review = await getReview(app, reviewId);
    expect(review?.status).toBe('unresolvable');
    expect(review?.resolved_at).not.toBeNull();
    expect((await getCallState(app, callId))?.status).toBe('review_closed');
    expect(await hasActiveReviewForCall(app, callId)).toBe(false);
    expect(await hasTerminalReviewForCall(app, callId)).toBe(true);

    const actions = await listByReview(app, reviewId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('mark_unresolvable');
    expect(actions[0]?.actor).toBe('alice');
    expect(actions[0]?.before).toMatchObject({ review_status: 'open', call_state_status: 'held' });
    expect(actions[0]?.after).toMatchObject({
      review_status: 'unresolvable',
      call_state_status: 'review_closed',
    });
  });

  it('trims the actor before storing it in the audit row', async () => {
    const callId = 'test-unres-trim';
    const reviewId = await seedHeld(callId);

    await markUnresolvable(app, callId, '  alice  ');

    const actions = await listByReview(app, reviewId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actor).toBe('alice');
  });

  it('rejects a missing/blank actor and changes nothing', async () => {
    const callId = 'test-unres-noactor';
    await seedHeld(callId);

    await expect(markUnresolvable(app, callId, '   ')).rejects.toMatchObject({
      code: 'DAL_VALIDATION_FAILED',
    });
    expect(await hasActiveReviewForCall(app, callId)).toBe(true);
    expect((await getCallState(app, callId))?.status).toBe('held');
  });

  it('throws when there is no active review', async () => {
    const callId = 'test-unres-noreview';
    await upsertCallState(app, { callId, source: 'test', currentStage: 'redact', status: 'held' });

    await expect(markUnresolvable(app, callId, 'alice')).rejects.toMatchObject({
      code: 'DAL_REVIEW_INVARIANT',
    });
  });

  it('throws on an already-terminal review (second call finds no active review)', async () => {
    const callId = 'test-unres-already';
    await seedHeld(callId);
    await markUnresolvable(app, callId, 'alice');

    await expect(markUnresolvable(app, callId, 'bob')).rejects.toMatchObject({
      code: 'DAL_REVIEW_INVARIANT',
    });
  });

  it('throws + rolls back (no audit) when call_state is not held', async () => {
    const callId = 'test-unres-notheld';
    const reviewId = await seedHeld(callId);
    // Corrupt: the review stays active but call_state is moved off `held`.
    await owner.query(`UPDATE call_state SET status='processing' WHERE call_id=$1`, [callId]);

    await expect(markUnresolvable(app, callId, 'alice')).rejects.toMatchObject({
      code: 'DAL_REVIEW_INVARIANT',
    });

    // Fully rolled back: review still active, call_state unchanged, no orphaned audit row.
    expect(await hasActiveReviewForCall(app, callId)).toBe(true);
    expect((await getCallState(app, callId))?.status).toBe('processing');
    expect(await listByReview(app, reviewId)).toHaveLength(0);
  });

  describe('markUnresolvableByReviewId (Task 6.2 — transition only, no audit)', () => {
    it('moves both rows and returns before/after WITHOUT writing an audit row', async () => {
      const callId = 'test-unres-byid-basic';
      const reviewId = await seedHeld(callId);

      const transition = await withTransaction(app, (client) =>
        markUnresolvableByReviewId(client, reviewId, 'carol'),
      );

      expect(transition.callId).toBe(callId);
      expect(transition.before).toEqual({ review_status: 'open', call_state_status: 'held' });
      expect(transition.after).toEqual({
        review_status: 'unresolvable',
        call_state_status: 'review_closed',
      });
      expect((await getReview(app, reviewId))?.status).toBe('unresolvable');
      expect((await getCallState(app, callId))?.status).toBe('review_closed');
      // The transition helper must NOT write the audit row (the handler owns that).
      expect(await listByReview(app, reviewId)).toHaveLength(0);
    });

    it('throws on a stale review id whose review is already terminal (does not touch another call)', async () => {
      const callId = 'test-unres-byid-stale';
      const reviewId = await seedHeld(callId);
      await markUnresolvable(app, callId, 'alice'); // review now terminal

      await expect(
        withTransaction(app, (client) => markUnresolvableByReviewId(client, reviewId, 'carol')),
      ).rejects.toMatchObject({ code: 'DAL_REVIEW_INVARIANT' });
    });
  });

  it('fails on duplicate active reviews without LIMIT-masking, and rolls back', async () => {
    const callId = 'test-unres-dup';
    await seedHeld(callId);

    // Simulate a pre-migration-012 DB: drop the unique index, insert a SECOND active row.
    await owner.query(`DROP INDEX ${ACTIVE_UNIQUE_IDX}`);
    try {
      await owner.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
         VALUES ($1, 'residual_pii_detected', 'open', now() + interval '1 hour')`,
        [callId],
      );

      await expect(markUnresolvable(app, callId, 'alice')).rejects.toMatchObject({
        code: 'DAL_REVIEW_INVARIANT',
      });

      // Rolled back: both rows still active, call_state still held.
      expect(await activeCount(callId)).toBe(2);
      expect((await getCallState(app, callId))?.status).toBe('held');
    } finally {
      await owner.query(
        `DELETE FROM review_queue WHERE call_id=$1 AND held_reason='residual_pii_detected'`,
        [callId],
      );
      await owner.query(
        `CREATE UNIQUE INDEX ${ACTIVE_UNIQUE_IDX} ON review_queue (call_id) WHERE status IN ('open', 'in_review')`,
      );
    }
  });
});
