import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { startRun } from '../../src/db/repositories/backfill-runs-repo.js';
import { insertRunCallIfAbsent } from '../../src/db/repositories/backfill-run-calls-repo.js';
import { recordDeadLetter } from '../../src/db/repositories/dead-letter-repo.js';
import { countNonTerminalTrackedCalls, isCallTerminal } from '../../src/backfill/terminal.js';

describe('isCallTerminal (pure predicate)', () => {
  it('treats completed/skipped/held/review_closed as terminal', () => {
    for (const s of ['completed', 'skipped', 'held', 'review_closed']) {
      expect(isCallTerminal(s, false)).toBe(true);
    }
  });
  it('treats processing as non-terminal unless dead-lettered', () => {
    expect(isCallTerminal('processing', false)).toBe(false);
    expect(isCallTerminal('processing', true)).toBe(true);
  });
});

describe.skipIf(!hasTestDb)('drain completion — countNonTerminalTrackedCalls', () => {
  let owner!: Pool;
  let app!: Pool;
  const DONE = 'bf-comp-done';
  const PENDING = 'bf-comp-pending';
  const WINDOW = { windowStart: new Date('2021-05-01Z'), windowEnd: new Date('2021-05-02Z') };

  async function seedCall(callId: string, status: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'dialpad-backfill', 'metadata-pre-filter', $2)
       ON CONFLICT (call_id) DO UPDATE SET status = EXCLUDED.status`,
      [callId, status],
    );
  }
  async function cleanup(): Promise<void> {
    for (const c of [DONE, PENDING]) {
      await owner.query(`DELETE FROM dead_letter WHERE call_id = $1`, [c]);
      await owner.query(`DELETE FROM backfill_run_calls WHERE call_id = $1`, [c]);
      await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [c]);
    }
    await owner.query(`DELETE FROM backfill_runs WHERE window_start = $1 AND window_end = $2`, [
      WINDOW.windowStart,
      WINDOW.windowEnd,
    ]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('withholds completion while a tracked call is still processing, then completes', async () => {
    const run = await startRun(app, { ...WINDOW, status: 'running' });
    await seedCall(DONE, 'completed');
    await seedCall(PENDING, 'processing');
    await insertRunCallIfAbsent(app, run.id, DONE);
    await insertRunCallIfAbsent(app, run.id, PENDING);

    // One non-terminal (PENDING) → drain not done.
    expect(await countNonTerminalTrackedCalls(app, run.id)).toBe(1);

    // A dead_letter row makes even a still-`processing` call terminal → drain done.
    await recordDeadLetter(app, {
      callId: PENDING,
      errorCode: 'QUEUE_RETRY_EXHAUSTED',
      rootCauseCategory: 'QUEUE_RETRY_EXHAUSTED',
    });
    expect(await countNonTerminalTrackedCalls(app, run.id)).toBe(0);

    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });

  it('counts a held call as terminal (set aside, not in flight)', async () => {
    const run = await startRun(app, { ...WINDOW, status: 'running' });
    await seedCall(PENDING, 'held');
    await insertRunCallIfAbsent(app, run.id, PENDING);
    expect(await countNonTerminalTrackedCalls(app, run.id)).toBe(0);
    await owner.query(`DELETE FROM backfill_runs WHERE id = $1`, [run.id]);
  });
});
