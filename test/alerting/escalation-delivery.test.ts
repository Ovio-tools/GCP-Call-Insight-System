import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Config } from '../../src/config/schema.js';
import { recordAlert } from '../../src/db/repositories/alert-events-repo.js';
import { ESCALATION_PREFIX } from '../../src/failure-model/index.js';
import {
  AlertWebhookError,
  type AlertWebhookPoster,
  escalateAndDeliver,
} from '../../src/alerting/index.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';

const WEBHOOK = 'https://hooks.example.com/services/SECRET_TOKEN_XYZ';
const WINDOW_MS = 15 * 60_000;

function cfg(overrides: Partial<Config> = {}): Config {
  return makeTestConfig({ ALERT_WEBHOOK_URL: WEBHOOK, ...overrides });
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

describe.skipIf(!hasTestDb)('escalateAndDeliver (Task 7.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  /** Seed an old, unacknowledged critical alert past the escalation window. */
  async function seedStaleCritical(dedup: string): Promise<void> {
    await recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: dedup,
    });
    await owner.query(
      `UPDATE alert_events SET created_at = now() - interval '1 hour' WHERE dedup_key = $1`,
      [dedup],
    );
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

  it('records an escalation row and delivers it via the webhook', async () => {
    await seedStaleCritical('esc:db-1');
    const { logger } = makeCapturingLogger();
    const cap = capturing();
    const escalated = await escalateAndDeliver(app, cfg(), {
      now: new Date(),
      windowMs: WINDOW_MS,
      logger,
      post: cap.post,
    });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.dedup_key.startsWith(ESCALATION_PREFIX)).toBe(true);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.text).toContain('DATABASE_UNAVAILABLE');
    const { rows } = await owner.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM alert_events WHERE dedup_key = $1`,
      [`${ESCALATION_PREFIX}esc:db-1`],
    );
    expect(rows[0]!.delivery_state).toBe('delivered');
  });

  it('a failed escalation delivery is attempted, sanitized-logged, and never throws', async () => {
    await seedStaleCritical('esc:db-2');
    const { logger, lines } = makeCapturingLogger();
    const escalated = await escalateAndDeliver(app, cfg(), {
      now: new Date(),
      windowMs: WINDOW_MS,
      logger,
      post: failingPoster,
    });
    expect(escalated).toHaveLength(1); // still recorded despite delivery failure
    const { rows } = await owner.query<{
      delivery_state: string;
      last_delivery_error: string | null;
    }>(`SELECT delivery_state, last_delivery_error FROM alert_events WHERE dedup_key = $1`, [
      `${ESCALATION_PREFIX}esc:db-2`,
    ]);
    expect(rows[0]!.delivery_state).toBe('failed');
    expect(rows[0]!.last_delivery_error).not.toContain('SECRET_TOKEN_XYZ');
    expect(lines.join('\n')).not.toContain('SECRET_TOKEN_XYZ');
  });
});
