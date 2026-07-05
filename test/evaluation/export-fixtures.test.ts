import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, seedKeyVersion } from '../db/_dal.js';
import { insertLabeledExample } from '../../src/db/repositories/labeled-examples-repo.js';
import { exportReviewedFixtures } from '../../src/evaluation/export-fixtures.js';
import { loadFixtures } from '../support/fixture-loader.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../../src/evaluation/version.js';

describe.skipIf(!hasTestDb)('exportReviewedFixtures (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  let root!: string;
  let classifyDir!: string;
  let extractDir!: string;

  const CALL = 'exp63-call';

  async function seedAcceptedExtract(): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'extract', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [CALL],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'schema_invalid', now() + interval '1 hour') RETURNING id`,
      [CALL],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await owner.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'exp', 'correct_extraction', '{}'::jsonb, '{}'::jsonb) RETURNING id`,
      [reviewId],
    );
    await insertLabeledExample(app, {
      operatorActionId: oa.rows[0]!.id,
      taskType: 'extract',
      reviewQueueId: reviewId,
      callId: CALL,
      heldReason: 'schema_invalid',
      reviewerActor: 'exp',
      redactedInput: 'a fully redacted extract transcript',
      expectedOutput: {
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'urgent',
        sentiment: 'frustrated',
      },
      sourcePromptVersion: 'extract-v1',
      promptVersionSource: 'current_constant',
      sourceSchemaVersion: 1,
      modelId: null,
      modelIdSource: 'none',
      evalSetVersion: EVAL_SET_VERSION,
      piiGateVersion: PII_GATE_VERSION,
    });
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id = $1`, [CALL]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id = $1)`,
      [CALL],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  function makeDirs(): void {
    root = mkdtempSync(join(tmpdir(), 'eval-export-'));
    classifyDir = join(root, 'classify', 'reviewed');
    extractDir = join(root, 'extract', 'reviewed');
  }

  it('writes deterministic filenames and identical output across runs', async () => {
    await seedAcceptedExtract();
    makeDirs();
    await exportReviewedFixtures(app, { classifyDir, extractDir });
    const files1 = readdirSync(extractDir)
      .filter((f) => f.startsWith('reviewed-'))
      .sort();
    expect(files1).toHaveLength(1);
    expect(files1[0]).toMatch(/^reviewed-\d+-extract-[0-9a-f-]+\.json$/);
    const content1 = readFileSync(join(extractDir, files1[0]!), 'utf8');
    await exportReviewedFixtures(app, { classifyDir, extractDir });
    const files2 = readdirSync(extractDir)
      .filter((f) => f.startsWith('reviewed-'))
      .sort();
    expect(files2).toEqual(files1);
    expect(readFileSync(join(extractDir, files2[0]!), 'utf8')).toBe(content1);
  });

  it('removes an orphan reviewed-*.json not in the accepted set and writes a MANIFEST', async () => {
    await seedAcceptedExtract();
    makeDirs();
    await exportReviewedFixtures(app, { classifyDir, extractDir });
    // Add an orphan reviewed file.
    const orphan = join(extractDir, 'reviewed-1-extract-deadbeef.json');
    writeFileSync(orphan, '{"name":"orphan"}');
    await exportReviewedFixtures(app, { classifyDir, extractDir });
    const files = readdirSync(extractDir);
    expect(files).not.toContain('reviewed-1-extract-deadbeef.json');
    expect(files).toContain('MANIFEST.json');
  });

  it('produces harness-loadable fixtures (loads via the shared loader, MANIFEST ignored)', async () => {
    await seedAcceptedExtract();
    makeDirs();
    await exportReviewedFixtures(app, { classifyDir, extractDir });
    // The shared loader reads the parent dir + its reviewed/ subdir; point it at extract/.
    const loaded = loadFixtures<{ name: string; modelResponse: { text: string } }>(
      join(root, 'extract'),
    );
    expect(loaded.length).toBe(1);
    // The generated modelResponse.text is a schema-valid 13-field record.
    const record = JSON.parse(loaded[0]!.modelResponse.text) as Record<string, unknown>;
    expect(record.call_intent).toBe('new_booking');
    expect(record.problem_statement).toBeDefined();
  });
});
