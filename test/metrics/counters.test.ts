import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';
import { COUNTER_LABEL_KEYS, type Counter, collectCounters } from '../../src/metrics/counters.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { runPipeline } from '../_run-pipeline.js';
import {
  defaultStageHandlers,
  type StageHandlers,
  type StageResult,
} from '../../src/pipeline/stages.js';

const find = (
  counters: Counter[],
  name: string,
  labels: Record<string, string>,
): Counter | undefined =>
  counters.find(
    (c) =>
      c.name === name &&
      Object.entries(labels).every(([k, v]) => c.labels[k] === v) &&
      Object.keys(c.labels).length === Object.keys(labels).length,
  );

describe.skipIf(!hasTestDb)('metrics counters', () => {
  let owner!: Pool;
  let app!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  const wipe = async (): Promise<void> => {
    await owner.query('DELETE FROM processing_log');
    await owner.query('DELETE FROM dead_letter');
    await owner.query('DELETE FROM alert_events');
    await owner.query('DELETE FROM review_queue');
    await owner.query('DELETE FROM call_state');
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(wipe);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  const seedCall = (callId: string, stage = 'classify'): Promise<unknown> =>
    owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status) VALUES ($1, 'test', $2, 'processing')`,
      [callId, stage],
    );
  const seedLog = (
    callId: string,
    stage: string,
    outcome: string,
    detail: Record<string, unknown> | null,
  ): Promise<unknown> =>
    owner.query(
      `INSERT INTO processing_log (call_id, stage, outcome, detail) VALUES ($1, $2, $3, $4::jsonb)`,
      [callId, stage, outcome, detail === null ? null : JSON.stringify(detail)],
    );

  it('emits named low-cardinality counters for ingested/extracted/held/dead-lettered/alerts', async () => {
    // 3 ingested calls (classify counters are covered by the real-state-machine test below).
    await seedCall('c-1');
    await seedCall('c-2');
    await seedCall('c-3');
    // 1 extracted (successful extract)
    await seedLog('c-1', 'extract', 'completed', null);
    // held by reason
    await owner.query(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at) VALUES
         ('c-2', 'classified_spam', 'open', now() + interval '24 hours'),
         ('c-3', 'missing_transcript', 'in_review', now() + interval '24 hours')`,
    );
    // dead-lettered by code
    await owner.query(
      `INSERT INTO dead_letter (call_id, error_code, root_cause_category) VALUES ('c-3', 'QUEUE_RETRY_EXHAUSTED', 'QUEUE_RETRY_EXHAUSTED')`,
    );
    // alerts by code + severity
    await owner.query(
      `INSERT INTO alert_events (error_code, root_cause_category, severity, dedup_key) VALUES
         ('DIALPAD_RATE_LIMITED', 'DIALPAD_RATE_LIMITED', 'medium', 'k1'),
         ('MODEL_MALFORMED_RESPONSE', 'MODEL_MALFORMED_RESPONSE', 'medium', 'k2')`,
    );

    const counters = await collectCounters(app, { environment: 'test' });

    expect(find(counters, 'calls_ingested_total', { environment: 'test' })?.value).toBe(3);
    expect(find(counters, 'calls_extracted_total', { environment: 'test' })?.value).toBe(1);
    expect(
      find(counters, 'calls_held_total', { environment: 'test', held_reason: 'classified_spam' })
        ?.value,
    ).toBe(1);
    expect(
      find(counters, 'calls_held_total', {
        environment: 'test',
        held_reason: 'missing_transcript',
      })?.value,
    ).toBe(1);
    expect(
      find(counters, 'calls_dead_lettered_total', {
        environment: 'test',
        error_code: 'QUEUE_RETRY_EXHAUSTED',
      })?.value,
    ).toBe(1);
    expect(
      find(counters, 'alerts_total', {
        environment: 'test',
        error_code: 'DIALPAD_RATE_LIMITED',
        severity: 'medium',
      })?.value,
    ).toBe(1);
  });

  it('counts EVERY classify outcome per bucket by driving the real state machine', async () => {
    // Each bucket routes to a DIFFERENT terminal outcome in the real handler — customer→completed,
    // non-customer→skipped (drop), spam & held→held. We run the REAL state machine with the exact
    // StageResults the classify handler returns, so skipCall/holdCall/advanceStage write the real
    // processing_log rows. No fake `completed` rows — that would hide the under-count bug.
    const cases: { callId: string; result: StageResult }[] = [
      { callId: 'c-cust', result: { action: 'continue', detail: { bucket: 'customer' } } },
      {
        callId: 'c-non',
        result: {
          action: 'drop',
          reason: 'classified_non_customer',
          detail: { bucket: 'non-customer' },
        },
      },
      {
        callId: 'c-spam',
        result: { action: 'hold', reason: 'classified_spam', detail: { bucket: 'spam' } },
      },
      {
        callId: 'c-held',
        result: { action: 'hold', reason: 'classifier_uncertain', detail: { bucket: 'held' } },
      },
    ];
    for (const { callId, result } of cases) {
      await seedCall(callId, 'classify');
      const handlers: StageHandlers = {
        ...defaultStageHandlers,
        classify: () => Promise.resolve(result),
      };
      await runPipeline(app, callId, silent, handlers);
    }

    const counters = await collectCounters(app, { environment: 'test' });
    for (const bucket of ['customer', 'non-customer', 'spam', 'held']) {
      expect(
        find(counters, 'calls_classified_total', { environment: 'test', bucket })?.value,
        `bucket ${bucket} should be counted once`,
      ).toBe(1);
    }
  });

  it('never emits a high-cardinality label and constrains bucket to the closed vocabulary', async () => {
    await seedCall('c-hc');
    await seedLog('c-hc', 'classify', 'completed', { bucket: 'customer' });
    // A value outside the classifier's enum must collapse to `unknown`, never be exposed raw.
    await seedCall('c-junk');
    await seedLog('c-junk', 'classify', 'completed', { bucket: 'JUNK-injected-value' });

    const counters = await collectCounters(app, { environment: 'test' });
    expect(counters.length).toBeGreaterThan(0);
    for (const c of counters) {
      for (const key of Object.keys(c.labels)) {
        expect(COUNTER_LABEL_KEYS).toContain(key);
      }
      // No per-call or job identifiers ever leak into a metric label.
      expect(c.labels).not.toHaveProperty('call_id');
      expect(c.labels).not.toHaveProperty('job_id');
    }
    for (const c of counters.filter((x) => x.name === 'calls_classified_total')) {
      expect(['customer', 'non-customer', 'spam', 'held', 'unknown']).toContain(c.labels.bucket);
    }
    // The injected value was collapsed, not exposed.
    expect(counters.some((c) => c.labels.bucket === 'JUNK-injected-value')).toBe(false);
    expect(
      find(counters, 'calls_classified_total', { environment: 'test', bucket: 'unknown' })?.value,
    ).toBe(1);
  });
});
