import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Config } from '../../src/config/schema.js';
import { alertEventRowSchema, deliveryStateSchema } from '../../src/db/schemas/alert-events.js';
import type { AlertEventRow } from '../../src/db/schemas/alert-events.js';
import {
  recordAlert,
  recordAlertWithInsertStatus,
} from '../../src/db/repositories/alert-events-repo.js';
import {
  AlertWebhookError,
  type AlertWebhookPoster,
  deliverAlertRow,
  emitAlert,
  retryPendingDeliveries,
} from '../../src/alerting/index.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';

const WEBHOOK = 'https://hooks.example.com/services/SECRET_TOKEN_ABC';
// Anchor to real time: directly-inserted rows get `next_attempt_at = DB now()`, so a fixed
// past NOW would leave the sweep's `next_attempt_at <= now` window forever behind them.
const NOW = new Date();
const LATER = new Date(NOW.getTime() + 10 * 60_000); // past the first backoff

function cfg(overrides: Partial<Config> = {}): Config {
  return makeTestConfig({
    ALERT_WEBHOOK_URL: WEBHOOK,
    ALERT_DELIVERY_BACKOFF_MS: 60_000,
    ...overrides,
  });
}

function capturing(): { post: AlertWebhookPoster; calls: { url: string; text: string }[] } {
  const calls: { url: string; text: string }[] = [];
  return {
    calls,
    post: (url, text) => {
      calls.push({ url, text });
      return Promise.resolve();
    },
  };
}

const failingPoster: AlertWebhookPoster = () =>
  Promise.reject(new AlertWebhookError('alert webhook returned status 500'));

describe.skipIf(!hasTestDb)('alert delivery reliability (Task 7.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function getRow(id: string): Promise<AlertEventRow> {
    const { rows } = await owner.query('SELECT * FROM alert_events WHERE id = $1', [id]);
    return alertEventRowSchema.parse(rows[0]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await owner.query('DELETE FROM alert_events');
  });
  afterAll(async () => {
    await owner.query('DELETE FROM alert_events');
    await owner.end();
    await app.end();
  });

  const input = {
    code: 'DATABASE_UNAVAILABLE',
    processingState: 'paused',
    context: { call_id: 'c-1' },
  } as const;

  it('first delivery succeeds → one message, row delivered; delivered text is the plain-language alert with no URL/PII', async () => {
    const { post, calls } = capturing();
    const { logger, lines } = makeCapturingLogger();
    const res = await emitAlert(app, cfg(), input, { now: NOW, logger, post });
    expect(res.inserted).toBe(true);
    expect(res.delivery).toBe('delivered');
    expect(calls).toHaveLength(1);
    const text = calls[0]!.text;
    expect(text).toContain('DATABASE_UNAVAILABLE');
    expect(text).toContain('Impact:');
    expect(text).toContain('Immediate remediation:');
    expect(text).toContain('Customer data safe:');
    expect(text).toContain('Runbook:');
    expect(text).toContain('test'); // environment
    expect(text).toContain(NOW.toISOString());
    // No leaks.
    expect(text).not.toContain('SECRET_TOKEN_ABC');
    expect(text).not.toContain(WEBHOOK);
    expect(lines.join('\n')).not.toContain('SECRET_TOKEN_ABC');

    const row = await getRow(await getFirstId());
    expect(row.delivery_state).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  async function getFirstId(): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      'SELECT id FROM alert_events ORDER BY created_at LIMIT 1',
    );
    return String(rows[0]!.id);
  }

  it('duplicate incident after a successful delivery sends no extra message', async () => {
    const { post, calls } = capturing();
    const { logger } = makeCapturingLogger();
    await emitAlert(app, cfg(), input, { now: NOW, logger, post });
    const second = await emitAlert(app, cfg(), input, { now: NOW, logger, post });
    expect(second.inserted).toBe(false);
    expect(second.delivery).toBe('not-attempted');
    expect(calls).toHaveLength(1);
  });

  it('first delivery fails → row failed with future next_attempt_at; retry sweep sends exactly once', async () => {
    const { logger } = makeCapturingLogger();
    const res = await emitAlert(app, cfg(), input, { now: NOW, logger, post: failingPoster });
    expect(res.delivery).toBe('failed');
    const id = await getFirstId();
    let row = await getRow(id);
    expect(row.delivery_state).toBe('failed');
    expect(row.delivery_attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(row.last_delivery_error).toBe('alert webhook returned status 500');
    expect(row.last_delivery_error).not.toContain(WEBHOOK);

    // Not due yet at NOW: the sweep skips it.
    const early = capturing();
    const earlyRes = await retryPendingDeliveries(app, cfg(), {
      now: NOW,
      logger,
      post: early.post,
    });
    expect(earlyRes.attempted).toBe(0);
    expect(early.calls).toHaveLength(0);

    // Due at LATER: delivered exactly once.
    const late = capturing();
    const lateRes = await retryPendingDeliveries(app, cfg(), {
      now: LATER,
      logger,
      post: late.post,
    });
    expect(lateRes.delivered).toBe(1);
    expect(late.calls).toHaveLength(1);
    row = await getRow(id);
    expect(row.delivery_state).toBe('delivered');

    // A further sweep does not re-send.
    const again = capturing();
    await retryPendingDeliveries(app, cfg(), { now: LATER, logger, post: again.post });
    expect(again.calls).toHaveLength(0);
  });

  it('a duplicate arriving before the retry still resolves to one eventual message', async () => {
    const { logger } = makeCapturingLogger();
    await emitAlert(app, cfg(), input, { now: NOW, logger, post: failingPoster });
    const dup = await emitAlert(app, cfg(), input, { now: NOW, logger, post: failingPoster });
    expect(dup.inserted).toBe(false); // deduped onto the one failed row
    const late = capturing();
    await retryPendingDeliveries(app, cfg(), { now: LATER, logger, post: late.post });
    expect(late.calls).toHaveLength(1);
  });

  it('producer coverage: a direct recordAlert insert is a pending, non-null-next_attempt obligation the sweep delivers', async () => {
    const row = await recordAlert(app, {
      errorCode: 'REDIS_UNAVAILABLE',
      rootCauseCategory: 'REDIS_UNAVAILABLE',
      severity: 'critical',
      dedupKey: 'REDIS_UNAVAILABLE:global',
      failureSnapshot: {},
    });
    // Backward-compatible signature: an AlertEventRow, not { row, inserted }.
    expect(row.id).toBeTruthy();
    expect((row as unknown as { inserted?: boolean }).inserted).toBeUndefined();
    const persisted = await getRow(row.id);
    expect(persisted.delivery_state).toBe('pending');
    expect(persisted.next_attempt_at).not.toBeNull();

    const { logger } = makeCapturingLogger();
    const cap = capturing();
    const res = await retryPendingDeliveries(app, cfg(), { now: LATER, logger, post: cap.post });
    expect(res.delivered).toBe(1);
    expect(cap.calls).toHaveLength(1);
    // Rendered from the row alone via catalog fallback (empty snapshot).
    expect(cap.calls[0]!.text).toContain('REDIS_UNAVAILABLE');
  });

  it('concurrent deliveries of the same owed row claim atomically → exactly one POST', async () => {
    // A single pending obligation both callers see (same row object, attempts = 0).
    const row = await recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: 'db:concurrent',
    });
    const { logger } = makeCapturingLogger();
    const cap = capturing();
    // Two overlapping sweeps / an escalate + a sweep hitting the same row at once. The atomic
    // compare-and-swap on delivery_attempts lets exactly one win; the loser claims nothing and
    // never POSTs.
    const [a, b] = await Promise.all([
      deliverAlertRow(app, cfg(), row, { now: NOW, logger, post: cap.post }),
      deliverAlertRow(app, cfg(), row, { now: NOW, logger, post: cap.post }),
    ]);
    expect([a, b].sort()).toEqual(['delivered', 'skipped']);
    expect(cap.calls).toHaveLength(1);
    const persisted = await getRow(row.id);
    expect(persisted.delivery_state).toBe('delivered');
    expect(persisted.delivery_attempts).toBe(1); // claimed exactly once, never double-counted
  });

  it('recordAlertWithInsertStatus reports inserted true for new and false for a deduped existing row', async () => {
    const first = await recordAlertWithInsertStatus(app, {
      errorCode: 'MIGRATION_FAILED',
      rootCauseCategory: 'MIGRATION_FAILED',
      severity: 'high',
      dedupKey: 'MIGRATION_FAILED:global',
    });
    expect(first.inserted).toBe(true);
    const second = await recordAlertWithInsertStatus(app, {
      errorCode: 'MIGRATION_FAILED',
      rootCauseCategory: 'MIGRATION_FAILED',
      severity: 'high',
      dedupKey: 'MIGRATION_FAILED:global',
    });
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it('delivery_state guard: raw SQL rejects an invalid state; zod rejects it; valid states parse', async () => {
    const row = await recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: 'db:guard',
    });
    await expect(
      owner.query(`UPDATE alert_events SET delivery_state = 'bogus' WHERE id = $1`, [row.id]),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
    expect(() => deliveryStateSchema.parse('bogus')).toThrow();
    for (const s of ['pending', 'delivered', 'failed']) {
      expect(deliveryStateSchema.parse(s)).toBe(s);
    }
  });

  it('render-from-row: an unrenderable (unknown error_code) row is marked failed, never crashes the sweep', async () => {
    // A direct insert with a code absent from the catalog.
    await owner.query(
      `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key, failure_snapshot)
       VALUES ('NOT_A_REAL_CODE', 'NOT_A_REAL_CODE', 'high', 'legacy:bad', '{}'::jsonb)`,
    );
    const { logger } = makeCapturingLogger();
    const cap = capturing();
    const res = await retryPendingDeliveries(app, cfg(), { now: LATER, logger, post: cap.post });
    expect(res.failed).toBe(1);
    expect(cap.calls).toHaveLength(0); // never POSTed
    const { rows } = await owner.query<{
      delivery_state: string;
      last_delivery_error: string | null;
    }>(`SELECT * FROM alert_events WHERE dedup_key = 'legacy:bad'`);
    expect(rows[0]!.delivery_state).toBe('failed');
    expect(rows[0]!.last_delivery_error).toContain('unrenderable');
  });

  it('sweep no-ops (and does not POST) when ALERT_WEBHOOK_URL is unset', async () => {
    await recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: 'db:nourl',
    });
    const { logger } = makeCapturingLogger();
    const cap = capturing();
    const res = await retryPendingDeliveries(app, makeTestConfig(), {
      now: LATER,
      logger,
      post: cap.post,
    });
    expect(res.attempted).toBe(0);
    expect(cap.calls).toHaveLength(0);
  });
});
