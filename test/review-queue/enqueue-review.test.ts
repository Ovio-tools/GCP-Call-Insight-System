import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { enqueueReview } from '../../src/db/repositories/review-queue-repo.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-enq-%';

describe.skipIf(!hasTestDb)('enqueueReview concurrency', () => {
  let owner!: Pool;
  let app!: Pool;

  const activeReviews = async (callId: string): Promise<{ held_reason: string }[]> =>
    (
      await owner.query<{ held_reason: string }>(
        `SELECT held_reason FROM review_queue WHERE call_id = $1 AND status IN ('open','in_review')`,
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

  it('resolves to the existing row when a concurrent insert commits during the conflict wait', async () => {
    const callId = 'test-enq-race';
    await upsertCallState(app, { callId, source: 'test', currentStage: 'redact', status: 'held' });

    // Transaction A inserts the active review row but does NOT commit yet.
    const clientA = await owner.connect();
    await clientA.query('BEGIN');
    await clientA.query(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
       VALUES ($1, 'redaction_failed', 'open', now() + interval '1 hour')`,
      [callId],
    );

    try {
      // B starts and BLOCKS on the partial unique index conflict (A's row is uncommitted).
      const bPromise = enqueueReview(app, {
        callId,
        heldReason: 'residual_pii_detected',
        slaDueAt: new Date(Date.now() + 3_600_000),
      });

      // Give B a moment to reach the lock wait, then let A commit so B's conflict materialises.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await clientA.query('COMMIT');

      // B must resolve to A's existing row — NOT throw (the pre-fix single-statement CTE would
      // miss A's just-committed row under B's frozen snapshot and throw).
      const row = await bPromise;
      expect(row.held_reason).toBe('redaction_failed');
    } finally {
      clientA.release();
    }

    // Exactly one active row survived the race.
    expect(await activeReviews(callId)).toHaveLength(1);
  });
});
