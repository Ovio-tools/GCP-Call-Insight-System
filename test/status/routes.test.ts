import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { enqueueReview } from '../../src/db/repositories/review-queue-repo.js';
import { recordHeartbeat } from '../../src/db/repositories/component-heartbeats-repo.js';
import { registerStatusRoutes } from '../../src/status/routes.js';
import { statusDtoSchema } from '../../src/status/dto.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';
import { makeInternalApp, login } from '../http/_helpers.js';

const silentLogger = { warn: () => undefined, info: () => undefined } as unknown as Logger;
const NOW = new Date('2026-07-01T12:00:00.000Z');
const SENTINEL = 'SENTINEL_PII_LEAK_9f3a';

describe.skipIf(!hasTestDb)('status surface routes (Task 7.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function wipe(): Promise<void> {
    await cleanupCalls(owner, '%');
    await owner.query('DELETE FROM alert_events');
    await owner.query('DELETE FROM component_heartbeats');
    await owner.query('DELETE FROM dead_letter');
  }

  async function makeHarness(): ReturnType<typeof makeInternalApp> {
    return makeInternalApp({ CLASSIFY_ENABLED: true }, undefined, (fastifyApp) => {
      registerStatusRoutes(fastifyApp, {
        pool: app,
        config: makeTestConfig({
          CLASSIFY_ENABLED: true,
          EXTRACT_ENABLED: true,
          STATUS_PAGE_REFRESH_SECONDS: 30,
        }),
        logger: silentLogger,
        now: () => NOW,
      });
    });
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await owner.end();
    await app.end();
  });

  it('GET /status and /status.json require authentication (401 unauthenticated)', async () => {
    const harness = await makeHarness();
    expect((await harness.app.inject({ method: 'GET', url: '/status' })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: 'GET', url: '/status.json' })).statusCode).toBe(401);
    await harness.app.close();
  });

  it('renders authenticated HTML with all stages + components', async () => {
    await upsertCallState(app, {
      callId: 'test-status-route',
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    await recordHeartbeat(app, { component: 'worker' });
    const harness = await makeHarness();
    const { cookie } = await login(harness);
    const res = await harness.app.inject({ method: 'GET', url: '/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Pipeline status');
    expect(res.body).toContain('Worker');
    expect(res.body).toContain('Store');
    await harness.app.close();
  });

  it('serves the same DTO as JSON, valid against the schema', async () => {
    const harness = await makeHarness();
    const { cookie } = await login(harness);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/status.json',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const parsed = statusDtoSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
  });

  it('never leaks PII planted in adjacent tables (HTML + JSON)', async () => {
    // A held call with a sentinel assignee, plus a clean_transcript body sentinel.
    await upsertCallState(app, {
      callId: 'test-status-pii',
      source: 'test',
      currentStage: 'redact',
      status: 'held',
    });
    await enqueueReview(app, {
      callId: 'test-status-pii',
      heldReason: 'missing_transcript',
      slaDueAt: NOW,
      assignee: SENTINEL,
    });
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score)
       VALUES ('test-status-pii', $1, 0.1)`,
      [SENTINEL],
    );

    const harness = await makeHarness();
    const { cookie } = await login(harness);
    const html = await harness.app.inject({ method: 'GET', url: '/status', headers: { cookie } });
    const json = await harness.app.inject({
      method: 'GET',
      url: '/status.json',
      headers: { cookie },
    });
    expect(html.body).not.toContain(SENTINEL);
    expect(json.body).not.toContain(SENTINEL);
    // Sanity: the held call IS represented (by reason), just not its PII.
    expect(json.body).toContain('missing_transcript');
    await harness.app.close();
  });
});
