import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool } from './_pg.js';
import { makeAppPool } from './_dal.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { upsertStructuredKnowledge } from '../../src/db/repositories/structured-knowledge-repo.js';
import { buildSampleReport } from '../../src/sample-validation/index.js';

/**
 * The side-by-side human-review report (Task 11.1): call id, pipeline status, redacted text,
 * extracted record, classifier result, hold reason, prompt/model versions, validation metadata —
 * and NO raw transcript, vault value, internal-only sentiment, or clear PII.
 */
describe.skipIf(!hasTestDb)('sample-validation report (Task 11.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'sv-report-call';
  const DENY = ['acme plumbing'];

  async function seedCallState(status: string, stage: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', $2, $3)
       ON CONFLICT (call_id) DO UPDATE SET current_stage = EXCLUDED.current_stage, status = EXCLUDED.status`,
      [CALL, stage, status],
    );
  }

  async function seedClassifyLog(bucket: string): Promise<void> {
    await owner.query(
      `INSERT INTO processing_log (call_id, stage, outcome, detail)
       VALUES ($1, 'classify', 'completed', jsonb_build_object('bucket', $2::text))`,
      [CALL, bucket],
    );
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM structured_knowledge WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM clean_transcripts WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM processing_log WHERE call_id = $1`, [CALL]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN (SELECT id FROM review_queue WHERE call_id = $1)`,
      [CALL],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
  }

  beforeAll(() => {
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('produces a PII-free side-by-side entry with redacted text and the extracted record', async () => {
    await seedCallState('completed', 'mark-retention-eligible');
    await upsertCleanTranscript(app, {
      callId: CALL,
      redactedText: 'Customer [NAME_1] reports a leak under the sink at [ADDRESS_1].',
      redactionRiskScore: 0.1,
      redactionReasons: [],
    });
    await seedClassifyLog('customer');
    await upsertStructuredKnowledge(app, {
      callId: CALL,
      callIntent: 'existing_job',
      serviceCategory: 'leak_detection_or_repair',
      urgency: 'routine',
      sentiment: 'frustrated', // internal-only; must NOT appear in the report
      problemStatement: 'Leak under the kitchen sink',
      symptoms: ['dripping'],
      customerLanguage: ['water everywhere'],
      schemaVersion: 1,
      promptVersion: 'extract-vX',
      modelId: 'claude-test-extract',
    });

    const entry = await buildSampleReport(app, CALL, { denyTerms: DENY, now: new Date(0) });

    expect(entry.call_id).toBe(CALL);
    expect(entry.pipeline_status).toBe('completed');
    expect(entry.current_stage).toBe('mark-retention-eligible');
    expect(entry.classifier_bucket).toBe('customer');
    expect(entry.hold_reason).toBeNull();
    expect(entry.redacted_text).toContain('[NAME_1]');
    expect(entry.extracted_record).not.toBeNull();
    expect(entry.extracted_record?.call_intent).toBe('existing_job');
    expect(entry.extracted_record?.problem_statement).toBe('Leak under the kitchen sink');
    expect(entry.prompt_version).toBe('extract-vX');
    expect(entry.model_id).toBe('claude-test-extract');
    expect(entry.validation.pii_guard_tripped).toBe(false);
    expect(entry.validation.redacted_text_present).toBe(true);
    expect(entry.validation.extracted_record_present).toBe(true);

    // Internal-only sentiment is never exposed, anywhere in the serialized entry.
    expect('sentiment' in (entry.extracted_record as object)).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('frustrated');
  });

  it('scrubs redacted text and flags the guard when a deny term survives into the clean row', async () => {
    await seedCallState('completed', 'mark-retention-eligible');
    await upsertCleanTranscript(app, {
      callId: CALL,
      redactedText: 'Caller from Acme Plumbing wants a quote', // deny-term leaked past redaction
      redactionRiskScore: 0.2,
      redactionReasons: [],
    });

    const entry = await buildSampleReport(app, CALL, { denyTerms: DENY, now: new Date(0) });

    expect(entry.validation.pii_guard_tripped).toBe(true);
    expect(entry.validation.pii_guard_categories.length).toBeGreaterThan(0);
    // The offending text is withheld, never emitted.
    expect(entry.redacted_text).toBeNull();
    expect(JSON.stringify(entry).toLowerCase()).not.toContain('acme plumbing');
  });

  it('reports a held call with its hold reason and no extracted record', async () => {
    await seedCallState('held', 'classify');
    await owner.query(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'classifier_uncertain', now() + interval '1 hour')`,
      [CALL],
    );

    const entry = await buildSampleReport(app, CALL, { denyTerms: DENY, now: new Date(0) });

    expect(entry.pipeline_status).toBe('held');
    expect(entry.hold_reason).toBe('classifier_uncertain');
    expect(entry.extracted_record).toBeNull();
    expect(entry.validation.extracted_record_present).toBe(false);
  });
});
