import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness, seedKnowledge } from './_harness.js';
import { login } from '../http/_helpers.js';
import { buildKnowledgeCsv } from '../../src/knowledge/csv.js';
import type { KnowledgeRecord } from '../../src/knowledge/dto.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

/**
 * CSV rows and `export.json` results agree field-for-field for the same filtered set: both derive
 * from the same sanitized records, so `buildKnowledgeCsv(export.json.results)` reproduces the CSV body
 * exactly. For a small unpaginated set, the view results equal the export results too.
 */
const PATTERN = 'test-kpar-%';

describe.skipIf(!hasTestDb)('knowledge export parity (Task 10.1)', () => {
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

  it('CSV body == buildKnowledgeCsv(export.json.results), and view == export for a small set', async () => {
    await seedKnowledge(owner, app, {
      callId: 'test-kpar-1',
      createdAt: '2026-07-01T00:00:00Z',
      problemStatement: 'a, tricky "value"',
      symptoms: ['one', 'two'],
      acquisitionSource: null,
    });
    await seedKnowledge(owner, app, {
      callId: 'test-kpar-2',
      createdAt: '2026-07-02T00:00:00Z',
      problemStatement: 'plain',
      customerLanguage: ['hello'],
    });
    const harness = await makeKnowledgeHarness(app);
    const { cookie } = await login(harness);

    const json = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.json',
      headers: { cookie },
    });
    const results = json.json<{ results: KnowledgeRecord[] }>().results;

    const csv = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv',
      headers: { cookie },
    });
    expect(csv.body).toBe(buildKnowledgeCsv(results));

    const view = await harness.app.inject({
      method: 'GET',
      url: '/knowledge.json',
      headers: { cookie },
    });
    const viewResults = view.json<{ results: KnowledgeRecord[] }>().results;
    expect(viewResults).toEqual(results);
    await harness.app.close();
  });
});
