import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { RedactionError } from '../../src/logging/redaction.js';
import { componentHeartbeatRowSchema } from '../../src/db/schemas/component-heartbeats.js';
import {
  listHeartbeats,
  recordHeartbeat,
} from '../../src/db/repositories/component-heartbeats-repo.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool } from './_dal.js';

/** Test-only component names so nothing collides with real heartbeats. */
const C1 = 'test-hb-worker';
const C2 = 'test-hb-reconciliation';

describe('component_heartbeats row schema (Task 7.3)', () => {
  const base = { component: 'x', last_run_at: new Date(), detail: {}, updated_at: new Date() };

  it('row schema rejects an invalid last_status so a bad stored value fails the read parse', () => {
    // Without this, aggregate.ts treats anything other than exactly 'degraded' as
    // healthy-eligible — a stray value would render an unhealthy component as healthy.
    expect(componentHeartbeatRowSchema.safeParse({ ...base, last_status: 'bogus' }).success).toBe(
      false,
    );
  });

  it('row schema accepts the two valid statuses', () => {
    for (const s of ['ok', 'degraded'] as const) {
      expect(componentHeartbeatRowSchema.parse({ ...base, last_status: s }).last_status).toBe(s);
    }
  });
});

describe.skipIf(!hasTestDb)('component-heartbeats repo (Task 7.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function clean(): Promise<void> {
    await owner.query(`DELETE FROM component_heartbeats WHERE component LIKE 'test-hb-%'`);
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

  it('app_role can insert a heartbeat (grant present) and stamps last_run_at in the DB', async () => {
    const row = await recordHeartbeat(app, { component: C1, detail: { processed: 3 } });
    expect(row.component).toBe(C1);
    expect(row.last_status).toBe('ok');
    expect(row.detail).toEqual({ processed: 3 });
    expect(row.last_run_at).toBeInstanceOf(Date);
  });

  it('upsert updates last_run_at + last_status on the single per-component row', async () => {
    const first = await recordHeartbeat(app, { component: C2, status: 'ok' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await recordHeartbeat(app, { component: C2, status: 'degraded' });
    expect(second.last_status).toBe('degraded');
    expect(second.last_run_at.getTime()).toBeGreaterThanOrEqual(first.last_run_at.getTime());
    const rows = await listHeartbeats(app);
    expect(rows.filter((r) => r.component === C2)).toHaveLength(1);
  });

  it('DB CHECK rejects an invalid last_status on insert and on update', async () => {
    // Raw SQL bypasses the DAL zod guard; the DB constraint is the last line of defense so no
    // path (manual fix, future writer) can strand a status the aggregator would misread.
    await expect(
      owner.query(
        `INSERT INTO component_heartbeats (component, last_run_at, last_status)
         VALUES ($1, now(), 'bogus')`,
        ['test-hb-badstatus'],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation

    await recordHeartbeat(app, { component: C1, status: 'ok', detail: { processed: 3 } });
    await expect(
      owner.query(`UPDATE component_heartbeats SET last_status = 'bogus' WHERE component = $1`, [
        C1,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a content/PII field in detail before it is persisted', async () => {
    await expect(
      recordHeartbeat(app, { component: C1, detail: { transcript: 'secret' } }),
    ).rejects.toBeInstanceOf(RedactionError);
    // Nothing leaked: the prior row's detail is unchanged.
    const rows = await listHeartbeats(app);
    expect(rows.find((r) => r.component === C1)?.detail).toEqual({ processed: 3 });
  });
});
