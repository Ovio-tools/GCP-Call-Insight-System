import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import {
  countStructuredKnowledge,
  listKnowledgeCallIdsPage,
  searchStructuredKnowledge,
  setStructuredKnowledgeSuperseded,
} from '../../src/db/repositories/structured-knowledge-repo.js';

describe.skipIf(!hasTestDb)('structured_knowledge supersede filter', () => {
  let pool: Pool;
  const stamp = Date.now();
  const canonical = `sk-canon-${stamp}`;
  const dup = `sk-dup-${stamp}`;
  // Three rows that deliberately share one identical created_at, to exercise the composite
  // keyset cursor's tie handling. Ordered `created_at DESC, call_id DESC` → tie-c, tie-b, tie-a.
  const TIE_TS = '2020-01-01T00:00:00Z';
  const tieIds = [`sk-tie-a-${stamp}`, `sk-tie-b-${stamp}`, `sk-tie-c-${stamp}`];
  const allIds = [canonical, dup, ...tieIds];

  const seedCallState = async (id: string) => {
    await pool.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1,'test','{}'::jsonb,'store','completed') ON CONFLICT DO NOTHING`,
      [id],
    );
  };

  const seed = async (id: string) => {
    await seedCallState(id);
    await pool.query(
      `INSERT INTO structured_knowledge
         (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id)
       VALUES ($1, 'new_booking', 'water_heater', 'routine', 'neutral', 1,'v1','m1')`,
      [id],
    );
  };

  const seedAt = async (id: string, createdAt: string) => {
    await seedCallState(id);
    await pool.query(
      `INSERT INTO structured_knowledge
         (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id, created_at)
       VALUES ($1, 'new_booking', 'water_heater', 'routine', 'neutral', 1,'v1','m1', $2::timestamptz)`,
      [id, createdAt],
    );
  };

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
    await seed(canonical);
    await seed(dup);
    for (const id of tieIds) await seedAt(id, TIE_TS);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM structured_knowledge WHERE call_id = ANY($1)`, [allIds]);
    await pool.query(`DELETE FROM call_state WHERE call_id = ANY($1)`, [allIds]);
    await pool.end();
  });

  it('hides a superseded row from search and count', async () => {
    const before = await countStructuredKnowledge(pool, {});
    const n = await setStructuredKnowledgeSuperseded(pool, {
      callId: dup,
      canonicalCallId: canonical,
    });
    expect(n).toBe(1);
    const after = await countStructuredKnowledge(pool, {});
    expect(after).toBe(before - 1);
    const rows = await searchStructuredKnowledge(pool, {}, { limit: 1000, offset: 0 });
    expect(rows.find((r) => r.call_id === dup)).toBeUndefined();
    expect(rows.find((r) => r.call_id === canonical)).toBeDefined();
  });

  it('is idempotent: re-superseding an already-superseded row writes nothing', async () => {
    const n = await setStructuredKnowledgeSuperseded(pool, {
      callId: dup,
      canonicalCallId: canonical,
    });
    expect(n).toBe(0);
  });

  it('never supersedes a row against itself (self-reference guard)', async () => {
    const n = await setStructuredKnowledgeSuperseded(pool, {
      callId: canonical,
      canonicalCallId: canonical,
    });
    expect(n).toBe(0);
    const rows = await searchStructuredKnowledge(pool, {}, { limit: 1000, offset: 0 });
    expect(rows.find((r) => r.call_id === canonical)).toBeDefined();
  });

  it('composite keyset cursor pages same-timestamp ties without skips or dupes', async () => {
    // The tie rows share the OLDEST created_at in the table, so start paging from a cursor
    // pinned just above them (same timestamp, a call_id sorting after all three) — this isolates
    // the tie group. `limit: 2` splits the 3-row tie ACROSS a page boundary, which is exactly the
    // case the old created_at-only cursor dropped: page 2 re-derived `created_at < TIE_TS` and
    // skipped the remaining same-timestamp rows.
    const startCursor = { createdAt: new Date(TIE_TS), callId: `sk-tie-z-${stamp}` };
    const page1 = (await listKnowledgeCallIdsPage(pool, { cursor: startCursor, limit: 2 })).filter(
      (r) => tieIds.includes(r.call_id),
    );
    expect(page1.length).toBe(2);
    const last = page1[page1.length - 1]!;

    // Page 2: thread the full composite key of page 1's last row.
    const page2 = (
      await listKnowledgeCallIdsPage(pool, {
        cursor: { createdAt: last.created_at, callId: last.call_id },
        limit: 100,
      })
    ).filter((r) => tieIds.includes(r.call_id));

    const seen = [...page1, ...page2].map((r) => r.call_id);
    // All 3 seeded tie rows appear exactly once across the two pages — no skips, no duplicates.
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...tieIds].sort());
  });
});
