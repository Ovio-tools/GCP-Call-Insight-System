import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import {
  countStructuredKnowledge,
  searchStructuredKnowledge,
  setStructuredKnowledgeSuperseded,
} from '../../src/db/repositories/structured-knowledge-repo.js';

describe.skipIf(!hasTestDb)('structured_knowledge supersede filter', () => {
  let pool: Pool;
  const canonical = `sk-canon-${Date.now()}`;
  const dup = `sk-dup-${Date.now()}`;

  const seed = async (id: string) => {
    await pool.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1,'test','{}'::jsonb,'store','completed') ON CONFLICT DO NOTHING`,
      [id],
    );
    await pool.query(
      `INSERT INTO structured_knowledge
         (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id)
       VALUES ($1, 'new_booking', 'water_heater', 'routine', 'neutral', 1,'v1','m1')`,
      [id],
    );
  };

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
    await seed(canonical);
    await seed(dup);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM structured_knowledge WHERE call_id = ANY($1)`, [[canonical, dup]]);
    await pool.query(`DELETE FROM call_state WHERE call_id = ANY($1)`, [[canonical, dup]]);
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
});
