import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repositories } from '../../src/db/index.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool } from './_dal.js';

const SOURCE = 'test-raw-webhook-repo';

/** insertWebhookEvent accepts explicit received_at / retention_eligible_at so audit
 * timestamps are deterministic and the row is purgeable by the retention cron. */
describe.skipIf(!hasTestDb)('raw_webhook_events insert', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM raw_webhook_events WHERE source = $1`, [SOURCE]);
    await owner.end();
    await app.end();
  });

  it('round-trips supplied received_at and retention_eligible_at', async () => {
    const stamp = new Date('2026-07-01T12:00:00.000Z');
    const row = await repositories.rawWebhookEvents.insertWebhookEvent(app, {
      source: SOURCE,
      payload: { event_id: 'evt-1', call_id: 'call-1', direction: 'inbound' },
      signatureStatus: 'valid',
      receivedAt: stamp,
      retentionEligibleAt: stamp,
    });
    expect(row.received_at.getTime()).toBe(stamp.getTime());
    expect(row.retention_eligible_at?.getTime()).toBe(stamp.getTime());
    expect(row.signature_status).toBe('valid');
  });

  it('falls back to DB now() for both received_at and retention_eligible_at when omitted', async () => {
    // Task 8.1 §2: a webhook event has no later stage to stamp it, so an omitted
    // retention_eligible_at is stamped at receipt (now()) — never left NULL, which would make a
    // purgeable row un-purgeable. (In production the route always supplies the value; this is the
    // direct-caller/reconciliation path.)
    const row = await repositories.rawWebhookEvents.insertWebhookEvent(app, {
      source: SOURCE,
      payload: { event_id: 'evt-2' },
      signatureStatus: 'valid',
    });
    expect(row.received_at).toBeInstanceOf(Date);
    expect(row.retention_eligible_at).toBeInstanceOf(Date);
  });
});
