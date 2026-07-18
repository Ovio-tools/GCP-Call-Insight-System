import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * Migration 1782864000012 — the "exactly one active review row per call" DB guarantee plus
 * the "every active row carries an SLA" CHECK, and their two loud `up` preflights.
 *
 * Rolling back ABOVE migrations exposes the pre-012 schema (review_queue exists from migration 2,
 * without the partial unique index / CHECK). Bump ABOVE when a later migration is stacked on top:
 * 012 + 013 (retention purge grants, Task 8.1) + 014 (reveal_raw enum) + 015 (reprocess_requests,
 * Task 6.2) + 016 (labeled_examples, Task 6.3) + 017 (key lifecycle, Task 8.2) + 018 (backfill run
 * status, Task 11.2) + 019 (kek_versions app read grant) + 1782864100000 (drop raw/vault from
 * DB-A, ADR 0008 Move 2) + 1782864100001 (grinder_pump service_category) + 1782864100002
 * (duplicate_call_leg drop reason) + 1782864100003 (structured_knowledge.superseded_by_call_id) = 12.
 */
const ABOVE = 12;
const PATTERN = 'test-rqau-%';

describe.skipIf(!hasTestDb)('migration 012 review_queue active-row invariants', () => {
  let pool!: Pool;

  const seedCall = (callId: string): Promise<unknown> =>
    pool.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'redact', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );

  const activeCount = async (callId: string): Promise<number> =>
    (
      await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM review_queue
          WHERE call_id = $1 AND status IN ('open', 'in_review')`,
        [callId],
      )
    ).rows[0]!.c;

  const cleanup = async (callId: string): Promise<void> => {
    await pool.query(`DELETE FROM review_queue WHERE call_id = $1`, [callId]);
    await pool.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
  };

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [PATTERN]);
    await pool.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [PATTERN]);
    await migrate('up'); // restore full schema for later suites
    await pool.end();
  });

  it('up fails loudly on pre-existing duplicate active rows, without auto-deleting them', async () => {
    const callId = 'test-rqau-dup';
    await migrate('down', ABOVE);
    try {
      await seedCall(callId);
      await pool.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
         VALUES ($1, 'redaction_failed', 'open', now() + interval '1 hour'),
                ($1, 'redaction_failed', 'open', now() + interval '1 hour')`,
        [callId],
      );

      await expect(migrate('up', ABOVE)).rejects.toThrow(/active review row per call/i);

      // The preflight must NOT auto-delete/merge — a human resolves duplicates first.
      expect(await activeCount(callId)).toBe(2);
    } finally {
      await cleanup(callId);
      await migrate('up');
    }
  });

  it('up fails loudly on a pre-existing active row with a NULL sla_due_at', async () => {
    const callId = 'test-rqau-nullsla';
    await migrate('down', ABOVE);
    try {
      await seedCall(callId);
      await pool.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
         VALUES ($1, 'redaction_failed', 'open', NULL)`,
        [callId],
      );

      await expect(migrate('up', ABOVE)).rejects.toThrow(/sla_due_at/i);
    } finally {
      await cleanup(callId);
      await migrate('up');
    }
  });

  it('after migration: the partial unique index blocks a second active row', async () => {
    const callId = 'test-rqau-unique';
    try {
      await seedCall(callId);
      await pool.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
         VALUES ($1, 'redaction_failed', 'open', now() + interval '1 hour')`,
        [callId],
      );
      await expect(
        pool.query(
          `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
           VALUES ($1, 'residual_pii_detected', 'open', now() + interval '1 hour')`,
          [callId],
        ),
      ).rejects.toThrow(/review_queue_one_active_per_call|duplicate key/i);

      // A resolved row is outside the partial index → allowed.
      await pool.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, resolved_at)
         VALUES ($1, 'redaction_failed', 'resolved', now() + interval '1 hour', now())`,
        [callId],
      );
    } finally {
      await cleanup(callId);
    }
  });

  it('after migration: the CHECK rejects an active row with a NULL sla_due_at', async () => {
    const callId = 'test-rqau-checknull';
    try {
      await seedCall(callId);
      await expect(
        pool.query(
          `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at)
           VALUES ($1, 'redaction_failed', 'open', NULL)`,
          [callId],
        ),
      ).rejects.toThrow(/review_queue_active_has_sla|check constraint/i);

      // A resolved row may have a NULL sla_due_at.
      await pool.query(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, resolved_at)
         VALUES ($1, 'redaction_failed', 'resolved', NULL, now())`,
        [callId],
      );
    } finally {
      await cleanup(callId);
    }
  });
});
