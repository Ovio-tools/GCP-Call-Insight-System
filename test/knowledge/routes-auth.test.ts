import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness, seedKnowledge } from './_harness.js';
import { login } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const ROUTES = ['/knowledge', '/knowledge.json', '/knowledge/export.csv', '/knowledge/export.json'];

describe('knowledge surface auth (Task 10.1)', () => {
  it('rejects every route unauthenticated with 401', async () => {
    // 401 short-circuits before the handler, so no DB is needed here.
    const harness = await makeKnowledgeHarness({} as unknown as Pool);
    for (const url of ROUTES) {
      const res = await harness.app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} unauthenticated`).toBe(401);
    }
    await harness.app.close();
  });

  it('redirects an unauthenticated browser (HTML) GET to the login page with returnTo', async () => {
    const harness = await makeKnowledgeHarness({} as unknown as Pool);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/knowledge?q=pump',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `/auth/login?returnTo=${encodeURIComponent('/knowledge?q=pump')}`,
    );
    await harness.app.close();
  });

  it('still returns 401 (not a redirect) for a non-GET browser request', async () => {
    const harness = await makeKnowledgeHarness({} as unknown as Pool);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/knowledge',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(401);
    await harness.app.close();
  });
});

describe.skipIf(!hasTestDb)('knowledge surface authenticated (Task 10.1)', () => {
  let owner!: Pool;
  let app!: Pool;
  const PATTERN = 'test-kauth-%';

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await seedKnowledge(owner, app, { callId: 'test-kauth-1', createdAt: '2026-07-01T00:00:00Z' });
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('serves each route 200 with the correct content type when authenticated', async () => {
    const harness = await makeKnowledgeHarness(app);
    const { cookie } = await login(harness);

    const expectations: [string, string][] = [
      ['/knowledge', 'text/html'],
      ['/knowledge.json', 'application/json'],
      ['/knowledge/export.csv', 'text/csv'],
      ['/knowledge/export.json', 'application/json'],
    ];
    for (const [url, contentType] of expectations) {
      const res = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, `${url} authenticated`).toBe(200);
      expect(res.headers['content-type'], url).toContain(contentType);
    }
    // The exports carry an attachment disposition.
    const csv = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv',
      headers: { cookie },
    });
    expect(csv.headers['content-disposition']).toContain('attachment');
    await harness.app.close();
  });
});
