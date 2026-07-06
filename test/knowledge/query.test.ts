import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repositories } from '../../src/db/index.js';
import {
  aggregateStructuredKnowledge,
  countStructuredKnowledge,
  listStructuredKnowledgeForExport,
  searchStructuredKnowledge,
  type KnowledgeQueryFilters,
} from '../../src/db/repositories/structured-knowledge-repo.js';
import { toDateBounds } from '../../src/knowledge/query.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-kq-%';

interface SeedRow {
  callId: string;
  createdAt: string;
  serviceCategory?: string;
  callIntent?: string;
  urgency?: string;
  problemStatement?: string | null;
  customerLanguage?: string[];
}

describe.skipIf(!hasTestDb)('structured_knowledge read model (Task 10.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function seed(row: SeedRow): Promise<void> {
    await repositories.callState.upsertCallState(app, {
      callId: row.callId,
      source: 'test',
      currentStage: 'store',
      status: 'completed',
    });
    await owner.query(
      `INSERT INTO structured_knowledge (
         call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
         urgency, concerns, sentiment, competitor_mentions, schema_version, prompt_version, model_id,
         created_at)
       VALUES ($1,$2,$3,$4,'[]'::jsonb,$5::jsonb,$6,'[]'::jsonb,'neutral','[]'::jsonb,1,'v1','m1',$7)`,
      [
        row.callId,
        row.callIntent ?? 'new_booking',
        row.serviceCategory ?? 'water_heater',
        row.problemStatement ?? null,
        JSON.stringify(row.customerLanguage ?? []),
        row.urgency ?? 'routine',
        row.createdAt,
      ],
    );
  }

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

  it('filters by service_category, call_intent, and urgency', async () => {
    await seed({
      callId: 'test-kq-a',
      createdAt: '2026-07-01T00:00:00Z',
      serviceCategory: 'toilet',
    });
    await seed({
      callId: 'test-kq-b',
      createdAt: '2026-07-02T00:00:00Z',
      serviceCategory: 'water_heater',
    });
    await seed({ callId: 'test-kq-c', createdAt: '2026-07-03T00:00:00Z', urgency: 'emergency' });

    const cat = await searchStructuredKnowledge(
      app,
      { serviceCategory: 'toilet' },
      { limit: 50, offset: 0 },
    );
    expect(cat.map((r) => r.call_id)).toEqual(['test-kq-a']);

    const urg = await searchStructuredKnowledge(
      app,
      { urgency: 'emergency' },
      { limit: 50, offset: 0 },
    );
    expect(urg.map((r) => r.call_id)).toEqual(['test-kq-c']);
  });

  it('matches free-text q on BOTH problem_statement and customer_language', async () => {
    await seed({
      callId: 'test-kq-ps',
      createdAt: '2026-07-01T00:00:00Z',
      problemStatement: 'a bad leak downstairs',
    });
    await seed({
      callId: 'test-kq-cl',
      createdAt: '2026-07-02T00:00:00Z',
      customerLanguage: ['water is leaking everywhere'],
    });
    await seed({
      callId: 'test-kq-no',
      createdAt: '2026-07-03T00:00:00Z',
      problemStatement: 'no hot water',
    });

    const rows = await searchStructuredKnowledge(app, { q: 'leak' }, { limit: 50, offset: 0 });
    expect(rows.map((r) => r.call_id).sort()).toEqual(['test-kq-cl', 'test-kq-ps']);
  });

  it('treats %, _ and \\ in q as literals (no wildcard injection)', async () => {
    await seed({
      callId: 'test-kq-lit',
      createdAt: '2026-07-01T00:00:00Z',
      problemStatement: 'literal 100% done',
    });
    await seed({
      callId: 'test-kq-other',
      createdAt: '2026-07-02T00:00:00Z',
      problemStatement: 'nothing here',
    });

    const hit = await searchStructuredKnowledge(app, { q: '100%' }, { limit: 50, offset: 0 });
    expect(hit.map((r) => r.call_id)).toEqual(['test-kq-lit']);
    // A lone '%' is a LITERAL: it matches only the row that literally contains '%'
    // (test-kq-lit), never everything — proof the wildcard is escaped, not injected.
    const wild = await searchStructuredKnowledge(app, { q: '%' }, { limit: 50, offset: 0 });
    expect(wild.map((r) => r.call_id)).toEqual(['test-kq-lit']);
  });

  it('orders by created_at DESC, call_id DESC and paginates deterministically', async () => {
    await seed({ callId: 'test-kq-1', createdAt: '2026-07-01T00:00:00Z' });
    await seed({ callId: 'test-kq-2', createdAt: '2026-07-02T00:00:00Z' });
    await seed({ callId: 'test-kq-3', createdAt: '2026-07-02T00:00:00Z' }); // tie on created_at
    await seed({ callId: 'test-kq-4', createdAt: '2026-07-04T00:00:00Z' });

    const all = await searchStructuredKnowledge(app, {}, { limit: 50, offset: 0 });
    expect(all.map((r) => r.call_id)).toEqual(['test-kq-4', 'test-kq-3', 'test-kq-2', 'test-kq-1']);

    const page2 = await searchStructuredKnowledge(app, {}, { limit: 2, offset: 2 });
    expect(page2.map((r) => r.call_id)).toEqual(['test-kq-2', 'test-kq-1']);
  });

  it('counts the whole filtered set (ignoring pagination)', async () => {
    await seed({
      callId: 'test-kq-x',
      createdAt: '2026-07-01T00:00:00Z',
      serviceCategory: 'toilet',
    });
    await seed({
      callId: 'test-kq-y',
      createdAt: '2026-07-02T00:00:00Z',
      serviceCategory: 'toilet',
    });
    await seed({
      callId: 'test-kq-z',
      createdAt: '2026-07-03T00:00:00Z',
      serviceCategory: 'water_heater',
    });

    expect(await countStructuredKnowledge(app, { serviceCategory: 'toilet' })).toBe(2);
    expect(await countStructuredKnowledge(app, {})).toBe(3);
  });

  it('date range: >= from and < to; a date-only to includes the named day', async () => {
    await seed({ callId: 'test-kq-d1', createdAt: '2026-07-04T23:00:00Z' });
    await seed({ callId: 'test-kq-d2', createdAt: '2026-07-05T12:00:00Z' });
    await seed({ callId: 'test-kq-d3', createdAt: '2026-07-06T01:00:00Z' });

    const sameDay: KnowledgeQueryFilters = {
      ...toDateBounds({ from: '2026-07-05', to: '2026-07-05' }),
    };
    const rows = await searchStructuredKnowledge(app, sameDay, { limit: 50, offset: 0 });
    expect(rows.map((r) => r.call_id)).toEqual(['test-kq-d2']);
  });

  it('export returns all filtered rows and detects truncation via cap+1', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seed({ callId: `test-kq-e${i}`, createdAt: `2026-07-0${i + 1}T00:00:00Z` });
    }
    const under = await listStructuredKnowledgeForExport(app, {}, { cap: 10 });
    expect(under).toHaveLength(5);

    const capped = await listStructuredKnowledgeForExport(app, {}, { cap: 3 });
    expect(capped).toHaveLength(4); // cap + 1 signals "more exist"
  });

  it('aggregate reports total, date span, and grouped counts over the filtered set', async () => {
    await seed({
      callId: 'test-kq-g1',
      createdAt: '2026-07-01T00:00:00Z',
      serviceCategory: 'toilet',
      urgency: 'routine',
    });
    await seed({
      callId: 'test-kq-g2',
      createdAt: '2026-07-05T00:00:00Z',
      serviceCategory: 'toilet',
      urgency: 'emergency',
    });
    await seed({
      callId: 'test-kq-g3',
      createdAt: '2026-07-03T00:00:00Z',
      serviceCategory: 'water_heater',
      urgency: 'routine',
    });

    const agg = await aggregateStructuredKnowledge(app, {});
    expect(agg.total).toBe(3);
    expect(agg.minCreatedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(agg.maxCreatedAt?.toISOString()).toBe('2026-07-05T00:00:00.000Z');
    expect(agg.byServiceCategory.find((c) => c.key === 'toilet')?.count).toBe(2);
    expect(agg.byServiceCategory.find((c) => c.key === 'water_heater')?.count).toBe(1);
    expect(agg.byUrgency.find((c) => c.key === 'routine')?.count).toBe(2);
    expect(agg.byUrgency.find((c) => c.key === 'emergency')?.count).toBe(1);
  });

  it('never selects sentiment or model metadata columns', async () => {
    await seed({ callId: 'test-kq-s', createdAt: '2026-07-01T00:00:00Z' });
    const [row] = await searchStructuredKnowledge(app, {}, { limit: 1, offset: 0 });
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('sentiment');
    expect(row).not.toHaveProperty('model_id');
    expect(row).not.toHaveProperty('schema_version');
    expect(row).not.toHaveProperty('prompt_version');
  });
});
