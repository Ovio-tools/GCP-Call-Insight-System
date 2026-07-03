import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { assertNoContentFields } from '../../src/logging/redaction.js';
import { recordAlertWithInsertStatus } from '../../src/db/repositories/alert-events-repo.js';
import type { AlertEventInsert } from '../../src/db/schemas/alert-events.js';
import type { Queryable } from '../../src/db/types.js';
import { setStatus } from '../../src/db/repositories/review-queue-repo.js';
import { scanStalledReviews } from '../../src/review-queue/scan.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';

const PATTERN = 'test-scan-%';
const config = makeTestConfig();

describe.skipIf(!hasTestDb)('scanStalledReviews (Task 6.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  const { logger } = makeCapturingLogger();

  /** Seed a held call + one active review row overdue by `minutesAgo`; returns its id. */
  async function seedHeld(
    callId: string,
    opts: { minutesAgo?: number; reason?: string } = {},
  ): Promise<string> {
    const { minutesAgo = 60, reason = 'missing_transcript' } = opts;
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
       VALUES ($1, $2, 'open', now() - ($3 * interval '1 minute')) RETURNING id`,
      [callId, reason, minutesAgo],
    );
    return rows[0]!.id;
  }

  const reviewRow = async (id: string): Promise<{ escalated_at: Date | null }> =>
    (
      await owner.query<{ escalated_at: Date | null }>(
        `SELECT escalated_at FROM review_queue WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  const alertsFor = async (
    id: string,
  ): Promise<
    { error_code: string; dedup_key: string; failure_snapshot: Record<string, unknown> }[]
  > =>
    (
      await owner.query<{
        error_code: string;
        dedup_key: string;
        failure_snapshot: Record<string, unknown>;
      }>(`SELECT error_code, dedup_key, failure_snapshot FROM alert_events WHERE dedup_key = $1`, [
        `REVIEW_QUEUE_STALLED:review_queue:${id}`,
      ])
    ).rows;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await owner.query(`DELETE FROM alert_events WHERE dedup_key LIKE 'REVIEW_QUEUE_STALLED:%'`);
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('escalates a past-due row once, emits one PII-free REVIEW_QUEUE_STALLED alert', async () => {
    const id = await seedHeld('test-scan-basic');

    const first = await scanStalledReviews(app, config, logger, new Date());
    expect(first).toEqual({ escalated: 1, failed: 0, lockedSkipped: 0 });

    const alerts = await alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.error_code).toBe('REVIEW_QUEUE_STALLED');
    expect(alerts[0]?.dedup_key).toBe(`REVIEW_QUEUE_STALLED:review_queue:${id}`);
    const snap = alerts[0]!.failure_snapshot;
    expect(snap.review_queue_id).toBe(id);
    expect(snap.held_reason).toBe('missing_transcript');
    expect(snap.context).toMatchObject({ call_id: 'test-scan-basic', environment: 'test' });
    // No transcript content / PII fields anywhere in the snapshot.
    expect(() => assertNoContentFields(snap)).not.toThrow();

    expect((await reviewRow(id)).escalated_at).not.toBeNull();

    // Second scan: the row is escalated_at IS NULL-filtered out, so nothing re-escalates.
    const second = await scanStalledReviews(app, config, logger, new Date());
    expect(second).toEqual({ escalated: 0, failed: 0, lockedSkipped: 0 });
    expect(await alertsFor(id)).toHaveLength(1);
  });

  it('a failed alert insert leaves the row eligible and marks the scan incomplete', async () => {
    const id = await seedHeld('test-scan-lost');
    const throwing = (): Promise<never> => Promise.reject(new Error('alert insert boom'));

    const result = await scanStalledReviews(app, config, logger, new Date(), {
      recordAlert: throwing,
    });
    expect(result.failed).toBe(1);
    expect(result.escalated).toBe(0);
    expect((await reviewRow(id)).escalated_at).toBeNull(); // rolled back
    expect(await alertsFor(id)).toHaveLength(0);

    // A clean re-run delivers the alert (eventual delivery, no silent escalation).
    const rerun = await scanStalledReviews(app, config, logger, new Date());
    expect(rerun.escalated).toBe(1);
    expect(await alertsFor(id)).toHaveLength(1);
  });

  it('one failing row does not strand later due rows', async () => {
    const idA = await seedHeld('test-scan-a', { minutesAgo: 120 }); // most overdue → processed first
    const idB = await seedHeld('test-scan-b', { minutesAgo: 60 });

    const failFirst = (client: Queryable, input: AlertEventInsert): Promise<unknown> =>
      input.dedupKey.includes(idA)
        ? Promise.reject(new Error('boom'))
        : recordAlertWithInsertStatus(client, input);

    const result = await scanStalledReviews(app, config, logger, new Date(), {
      recordAlert: failFirst,
    });
    expect(result.failed).toBe(1);
    expect(result.escalated).toBe(1);
    expect((await reviewRow(idA)).escalated_at).toBeNull();
    expect((await reviewRow(idB)).escalated_at).not.toBeNull();
    expect(await alertsFor(idB)).toHaveLength(1);
  });

  it('a re-held call after resolve gets its own alert (id-scoped dedup)', async () => {
    const idA = await seedHeld('test-scan-reheld');
    await scanStalledReviews(app, config, logger, new Date());
    await setStatus(app, idA, 'resolved');

    // Re-hold the same call → a NEW active review row, still overdue.
    const idB = await seedHeld('test-scan-reheld');
    await scanStalledReviews(app, config, logger, new Date());

    expect(idB).not.toBe(idA);
    expect(await alertsFor(idA)).toHaveLength(1);
    expect(await alertsFor(idB)).toHaveLength(1); // not suppressed by A's still-open alert
  });

  it('drains beyond a single batch (empty ::uuid[] safe)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedHeld(`test-scan-batch-${i}`));

    const result = await scanStalledReviews(app, config, logger, new Date(), { batchSize: 2 });
    expect(result.escalated).toBe(5);
    expect(result.failed).toBe(0);
    for (const id of ids) expect(await alertsFor(id)).toHaveLength(1);
  });

  it('skips a concurrently locked row without spinning, and withholds via lockedSkipped', async () => {
    const idA = await seedHeld('test-scan-locked', { minutesAgo: 120 });
    const idB = await seedHeld('test-scan-open', { minutesAgo: 60 });

    // Hold a row lock on A in a separate transaction.
    const locker = await owner.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM review_queue WHERE id = $1 FOR UPDATE', [idA]);
    try {
      const result = await scanStalledReviews(app, config, logger, new Date(), { batchSize: 5 });
      expect(result.lockedSkipped).toBe(1);
      expect(result.escalated).toBe(1);
      expect((await reviewRow(idA)).escalated_at).toBeNull();
      expect((await reviewRow(idB)).escalated_at).not.toBeNull();
      expect(await alertsFor(idB)).toHaveLength(1);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});
