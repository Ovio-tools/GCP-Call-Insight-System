import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness, seedKnowledge } from './_harness.js';
import { login } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

/**
 * The HTML export links carry ONLY the validated filter params — never `page`/`page_size` (Finding 2)
 * — so an export always covers the full filtered set, not the page the user is viewing.
 */
const PATTERN = 'test-klink-%';

describe.skipIf(!hasTestDb)('knowledge export links (Task 10.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('renders export hrefs with the filter params only, no page/page_size', async () => {
    await seedKnowledge(owner, app, {
      callId: 'test-klink-1',
      createdAt: '2026-07-01T00:00:00Z',
      serviceCategory: 'water_heater',
      problemStatement: 'a leak',
    });
    const harness = await makeKnowledgeHarness(app);
    const { cookie } = await login(harness);

    const res = await harness.app.inject({
      method: 'GET',
      url: '/knowledge?service_category=water_heater&q=leak&page=2',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const hrefs = [...res.body.matchAll(/href="(\/knowledge\/export\.(?:csv|json)[^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      expect(href).toContain('service_category=water_heater');
      expect(href).toContain('q=leak');
      expect(href).not.toContain('page');
    }
    await harness.app.close();
  });
});
