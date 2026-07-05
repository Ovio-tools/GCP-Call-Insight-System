import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, seedKeyVersion } from '../db/_dal.js';
import { syncLabeledExamples } from '../../src/evaluation/sync.js';
import { listAcceptedExamples } from '../../src/db/repositories/labeled-examples-repo.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from '../../src/evaluation/version.js';

/** A no-op logger with capture, sufficient for the sync's structured lines. */
function makeLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = [];
  const rec =
    () =>
    (obj: unknown, msg?: unknown): void => {
      lines.push({ obj, msg });
    };
  const logger = {
    info: rec(),
    warn: rec(),
    error: rec(),
    debug: rec(),
    fatal: rec(),
    trace: rec(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

describe.skipIf(!hasTestDb)('syncLabeledExamples (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  const P = 'sync63-';

  interface SeedOpts {
    action: string;
    heldReason: string;
    after: Record<string, unknown>;
    clean?: string | null; // null → no clean transcript row
    createdAt?: string;
    stage?: string;
  }

  async function seed(
    callId: string,
    opts: SeedOpts,
  ): Promise<{ actionId: string; reviewId: string }> {
    const stage = opts.stage ?? 'extract';
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', $2, 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId, stage],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
      [callId, opts.heldReason],
    );
    const reviewId = rq.rows[0]!.id;
    const oa = await owner.query<{ id: string }>(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after, created_at)
       VALUES ($1, 'reviewer-x', $2, '{}'::jsonb, $3::jsonb, COALESCE($4::timestamptz, now()))
       RETURNING id`,
      [reviewId, opts.action, JSON.stringify(opts.after), opts.createdAt ?? null],
    );
    if (opts.clean !== null) {
      await owner.query(
        `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons)
         VALUES ($1, $2, 0.1, '[]'::jsonb) ON CONFLICT (call_id) DO NOTHING`,
        [callId, opts.clean ?? 'a clean redacted transcript'],
      );
    }
    return { actionId: oa.rows[0]!.id, reviewId };
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM model_invocations WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
      [`${P}%`],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM clean_transcripts WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${P}%`]);
  }

  const EXTRACT_ENUMS = {
    call_intent: 'new_booking',
    service_category: 'water_heater',
    urgency: 'urgent',
    sentiment: 'frustrated',
    target_stage: 'verbatim-pii-scan',
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('produces exactly one accepted classify + one accepted extract label', async () => {
    await seed(`${P}classify`, {
      action: 'approve',
      heldReason: 'classifier_uncertain',
      after: { action_params: { target_stage: 'extract', reviewer_classification_written: true } },
      stage: 'classify',
      clean: 'customer wants a water heater looked at',
    });
    await seed(`${P}extract`, {
      action: 'correct_extraction',
      heldReason: 'schema_invalid',
      after: { action_params: EXTRACT_ENUMS },
      stage: 'extract',
      clean: 'a redacted extract transcript',
    });
    const { logger } = makeLogger();
    const summary = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(summary.accepted).toBe(2);
    expect(summary.failed).toBe(0);

    const rows = (await listAcceptedExamples(app)).filter((r) => r.call_id.startsWith(P));
    const classify = rows.find((r) => r.task_type === 'classify')!;
    expect(classify.expected_output).toEqual({ bucket: 'customer' });
    expect(classify.source_prompt_version).toBe('classify-v1');
    expect(classify.prompt_version_source).toBe('current_constant');
    expect(classify.model_id).toBeNull();
    expect(classify.model_id_source).toBe('none');
    const extract = rows.find((r) => r.task_type === 'extract')!;
    expect(extract.expected_output).toEqual({
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'urgent',
      sentiment: 'frustrated',
    });
    expect(extract.source_schema_version).toBe(1);
  });

  it('is idempotent under a re-run (no duplicates, second run all already_present)', async () => {
    await seed(`${P}dup`, {
      action: 'mark_spam',
      heldReason: 'classified_spam',
      after: { action_params: {} },
      stage: 'classify',
    });
    const { logger } = makeLogger();
    const first = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(first.accepted).toBe(1);
    const second = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(second.accepted).toBe(0);
    expect(second.already_present).toBe(1);
    const rows = (await listAcceptedExamples(app)).filter((r) => r.call_id === `${P}dup`);
    expect(rows).toHaveLength(1);
  });

  it('chooses the latest pre-action model invocation prompt version among several', async () => {
    const { actionId } = await seed(`${P}prov`, {
      action: 'mark_non_customer',
      heldReason: 'classifier_uncertain',
      after: { action_params: {} },
      stage: 'classify',
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    void actionId;
    await owner.query(
      `INSERT INTO model_invocations (call_id, stage, model_id, prompt_version, outcome, created_at)
       VALUES ($1, 'classify', 'haiku-A', 'classify-v0', 'success', '2026-07-04T10:00:00.000Z'),
              ($1, 'classify', 'haiku-B', 'classify-v1', 'success', '2026-07-04T20:00:00.000Z'),
              ($1, 'classify', 'haiku-C', 'classify-v2', 'success', '2026-07-06T00:00:00.000Z')`,
      [`${P}prov`],
    );
    const { logger } = makeLogger();
    await syncLabeledExamples(app, { denyTerms: [], logger });
    const row = (await listAcceptedExamples(app)).find((r) => r.call_id === `${P}prov`)!;
    expect(row.source_prompt_version).toBe('classify-v1');
    expect(row.prompt_version_source).toBe('model_invocations');
    expect(row.model_id).toBe('haiku-B');
    expect(row.model_id_source).toBe('model_invocations');
  });

  it('rejects a PII-laced transcript content-free and does not accept it', async () => {
    await seed(`${P}pii`, {
      action: 'mark_spam',
      heldReason: 'classified_spam',
      after: { action_params: {} },
      stage: 'classify',
      clean: 'please call me back at 5551234567',
    });
    const { logger } = makeLogger();
    const summary = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(summary.accepted).toBe(0);
    expect(summary.rejected_pii).toBe(1);
    const rej = await owner.query<{ rejection_reason: string; rejection_counts: unknown }>(
      `SELECT rejection_reason, rejection_counts FROM labeled_example_rejections WHERE call_id = $1`,
      [`${P}pii`],
    );
    expect(rej.rows[0]!.rejection_reason).toBe('pii');
    expect(JSON.stringify(rej.rows[0]!.rejection_counts)).not.toContain('5551234567');
  });

  it('records a terminal content-free missing_clean rejection and does not duplicate on re-run', async () => {
    await seed(`${P}missing`, {
      action: 'mark_spam',
      heldReason: 'classified_spam',
      after: { action_params: {} },
      stage: 'classify',
      clean: null,
    });
    const { logger } = makeLogger();
    const first = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(first.missing_clean).toBe(1);
    const second = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(second.missing_clean).toBe(0);
    expect(second.already_present).toBe(1);
    const rej = await owner.query(`SELECT id FROM labeled_example_rejections WHERE call_id = $1`, [
      `${P}missing`,
    ]);
    expect(rej.rows).toHaveLength(1);
  });

  it('rejects an extract correction with invalid enums as a content-free schema rejection', async () => {
    await seed(`${P}schema`, {
      action: 'correct_extraction',
      heldReason: 'schema_invalid',
      after: { action_params: { ...EXTRACT_ENUMS, urgency: 'not-real' } },
      stage: 'extract',
    });
    const { logger } = makeLogger();
    const summary = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(summary.rejected_schema).toBe(1);
    expect(summary.accepted).toBe(0);
    const rej = await owner.query<{ rejection_reason: string }>(
      `SELECT rejection_reason FROM labeled_example_rejections WHERE call_id = $1`,
      [`${P}schema`],
    );
    expect(rej.rows[0]!.rejection_reason).toBe('schema');
  });

  it('skips approve on a non-classifier_uncertain reason (not a label)', async () => {
    await seed(`${P}skip`, {
      action: 'approve',
      heldReason: 'emergency_review',
      after: { action_params: { target_stage: 'verbatim-pii-scan' } },
      stage: 'verbatim-pii-scan',
    });
    const { logger } = makeLogger();
    const summary = await syncLabeledExamples(app, { denyTerms: [], logger });
    expect(summary.accepted).toBe(0);
    expect(summary.already_present).toBe(0);
    const any = await owner.query(
      `SELECT 1 FROM labeled_examples WHERE call_id = $1
       UNION ALL SELECT 1 FROM labeled_example_rejections WHERE call_id = $1`,
      [`${P}skip`],
    );
    expect(any.rows).toHaveLength(0);
  });

  it('is version-scoped: an old accepted row does not block a new pii_gate_version', async () => {
    await seed(`${P}ver`, {
      action: 'mark_spam',
      heldReason: 'classified_spam',
      after: { action_params: {} },
      stage: 'classify',
    });
    const { logger } = makeLogger();
    await syncLabeledExamples(app, { denyTerms: [], logger });
    // Simulate a gate-version bump by inserting under the current version, then reading a
    // hypothetical next version yields nothing yet (the current run is the only version present).
    const cur = (
      await listAcceptedExamples(app, {
        evalSetVersion: EVAL_SET_VERSION,
        piiGateVersion: PII_GATE_VERSION,
      })
    ).filter((r) => r.call_id === `${P}ver`);
    const next = (
      await listAcceptedExamples(app, {
        evalSetVersion: EVAL_SET_VERSION,
        piiGateVersion: PII_GATE_VERSION + 1,
      })
    ).filter((r) => r.call_id === `${P}ver`);
    expect(cur).toHaveLength(1);
    expect(next).toHaveLength(0);
  });
});
