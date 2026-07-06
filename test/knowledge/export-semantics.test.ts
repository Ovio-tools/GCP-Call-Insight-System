import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness, seedKnowledge } from './_harness.js';
import { login } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

/**
 * View is paginated; export returns ALL rows matching the filters (not one page), capped at
 * KNOWLEDGE_MAX_EXPORT_ROWS with truncation via CSV `X-Export-*` headers / JSON `truncated`
 * (Findings 1 & 3). The CSV body is strictly header + record rows — never a note row.
 */
const PATTERN = 'test-ksem-%';

describe.skipIf(!hasTestDb)('knowledge export semantics (Task 10.1)', () => {
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

  it('export returns ALL filtered rows while the view returns one page', async () => {
    // 5 rows, page_size 2 → view page 2 has 2 rows; exports have all 5.
    for (let i = 0; i < 5; i += 1) {
      await seedKnowledge(owner, app, {
        callId: `test-ksem-${i}`,
        createdAt: `2026-07-0${i + 1}T00:00:00Z`,
      });
    }
    const harness = await makeKnowledgeHarness(app, {
      config: { KNOWLEDGE_PAGE_SIZE_DEFAULT: 2, KNOWLEDGE_PAGE_SIZE_MAX: 2 },
    });
    const { cookie } = await login(harness);

    const view = await harness.app.inject({
      method: 'GET',
      url: '/knowledge.json?page=2',
      headers: { cookie },
    });
    const viewBody = view.json<{ results: unknown[]; total: number; page: number }>();
    expect(viewBody.total).toBe(5);
    expect(viewBody.results).toHaveLength(2);

    const json = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.json',
      headers: { cookie },
    });
    const exportBody = json.json<{ results: unknown[]; truncated: boolean; total: number }>();
    expect(exportBody.results).toHaveLength(5);
    expect(exportBody.truncated).toBe(false);
    expect(exportBody.total).toBe(5);

    const csv = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv',
      headers: { cookie },
    });
    // header + 5 data rows, no note row.
    expect(csv.body.split('\n')).toHaveLength(6);
    expect(csv.headers['x-export-truncated']).toBe('false');
    expect(csv.headers['x-export-returned-rows']).toBe('5');
    expect(csv.headers['x-export-total-rows']).toBe('5');

    await harness.app.close();
  });

  it('caps the export and signals truncation (CSV headers + JSON truncated)', async () => {
    // cap = 3, seed 5 → export emits exactly 3 rows, truncated true, total 5.
    for (let i = 0; i < 5; i += 1) {
      await seedKnowledge(owner, app, {
        callId: `test-ksem-cap-${i}`,
        createdAt: `2026-07-0${i + 1}T00:00:00Z`,
      });
    }
    const harness = await makeKnowledgeHarness(app, { config: { KNOWLEDGE_MAX_EXPORT_ROWS: 3 } });
    const { cookie } = await login(harness);

    const csv = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv',
      headers: { cookie },
    });
    // header + exactly cap (3) data rows — no note row.
    expect(csv.body.split('\n')).toHaveLength(4);
    expect(csv.headers['x-export-truncated']).toBe('true');
    expect(csv.headers['x-export-returned-rows']).toBe('3');
    expect(csv.headers['x-export-total-rows']).toBe('5');

    const json = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.json',
      headers: { cookie },
    });
    const body = json.json<{ results: unknown[]; truncated: boolean; total: number }>();
    expect(body.results).toHaveLength(3);
    expect(body.truncated).toBe(true);
    expect(body.total).toBe(5);

    await harness.app.close();
  });
});
