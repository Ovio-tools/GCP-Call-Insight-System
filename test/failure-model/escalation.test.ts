import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repositories } from '../../src/db/index.js';
import type { AlertEventRow } from '../../src/db/schemas/alert-events.js';
import { escalateStaleAlerts, shouldEscalate } from '../../src/failure-model/index.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';

const WINDOW = 15 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0); // fixed epoch for deterministic boundaries

function row(overrides: Partial<AlertEventRow> = {}): AlertEventRow {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    error_code: 'DATABASE_UNAVAILABLE',
    root_cause_category: 'DATABASE_UNAVAILABLE',
    severity: 'critical',
    dedup_key: 'test-esc:c-1',
    acknowledged_at: null,
    created_at: new Date(NOW - WINDOW),
    failure_snapshot: {},
    delivery_state: 'pending',
    delivery_attempts: 0,
    next_attempt_at: new Date(NOW - WINDOW),
    delivered_at: null,
    last_delivery_error: null,
    ...overrides,
  };
}

describe('shouldEscalate', () => {
  const now = new Date(NOW);

  it('escalates an unacked critical exactly at the window boundary', () => {
    expect(shouldEscalate(row({ created_at: new Date(NOW - WINDOW) }), now, WINDOW)).toBe(true);
  });

  it('does not escalate one millisecond before the window', () => {
    expect(shouldEscalate(row({ created_at: new Date(NOW - (WINDOW - 1)) }), now, WINDOW)).toBe(
      false,
    );
  });

  it('does not escalate a future-dated alert', () => {
    expect(shouldEscalate(row({ created_at: new Date(NOW + 1000) }), now, WINDOW)).toBe(false);
  });

  it('does not escalate acknowledged, non-critical, or already-escalation rows', () => {
    expect(shouldEscalate(row({ acknowledged_at: new Date(NOW) }), now, WINDOW)).toBe(false);
    expect(shouldEscalate(row({ severity: 'high' }), now, WINDOW)).toBe(false);
    expect(shouldEscalate(row({ dedup_key: 'escalation:test-esc:c-1' }), now, WINDOW)).toBe(false);
  });

  it('throws on a non-positive or non-finite window', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => shouldEscalate(row(), now, bad)).toThrow();
    }
  });
});

const DEDUP = 'test-esc:c-1';
const ESC = `escalation:${DEDUP}`;

describe.skipIf(!hasTestDb)('escalateStaleAlerts (DB)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function count(dedupKey: string): Promise<number> {
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_events WHERE dedup_key = $1`,
      [dedupKey],
    );
    return Number(res.rows[0]?.n);
  }

  /** recordAlert stamps created_at = now(); age the row so it is past the window. */
  async function age(dedupKey: string): Promise<void> {
    await owner.query(
      `UPDATE alert_events SET created_at = now() - interval '1 hour' WHERE dedup_key = $1`,
      [dedupKey],
    );
  }

  async function clean(): Promise<void> {
    await owner.query(
      `DELETE FROM alert_events WHERE dedup_key LIKE 'test-esc:%' OR dedup_key LIKE 'escalation:test-esc:%'`,
    );
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await clean();
  });

  afterAll(async () => {
    await clean();
    await owner.end();
    await app.end();
  });

  it('escalates a stale critical alert, idempotently, without recursing', async () => {
    await repositories.alertEvents.recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: DEDUP,
    });
    await age(DEDUP);

    const first = await escalateStaleAlerts(app, { now: new Date(), windowMs: WINDOW });
    expect(first).toHaveLength(1);
    expect(await count(ESC)).toBe(1);

    // Second run: the original is still stale but recordAlert dedups; the escalation row is
    // prefix-guarded. No new escalation row.
    await escalateStaleAlerts(app, { now: new Date(), windowMs: WINDOW });
    expect(await count(ESC)).toBe(1);

    // Even after aging the escalation row itself, it must not spawn escalation:escalation:...
    await age(ESC);
    await escalateStaleAlerts(app, { now: new Date(), windowMs: WINDOW });
    expect(await count(`escalation:${ESC}`)).toBe(0);
  });
});
