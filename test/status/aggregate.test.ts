import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { PIPELINE_STAGES } from '../../src/pipeline/stages.js';
import { utcDay } from '../../src/model/cost.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { enqueueReview } from '../../src/db/repositories/review-queue-repo.js';
import { recordDeadLetter } from '../../src/db/repositories/dead-letter-repo.js';
import { upsertDailyCost } from '../../src/db/repositories/daily-cost-usage-repo.js';
import { recordHeartbeat } from '../../src/db/repositories/component-heartbeats-repo.js';
import { recordAlert } from '../../src/db/repositories/alert-events-repo.js';
import { buildStatus } from '../../src/status/aggregate.js';
import { dbStageToDtoKey } from '../../src/status/stages.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';

const silentLogger = { warn: () => undefined, info: () => undefined } as unknown as Logger;
const now = new Date();
const day = utcDay(now);

describe.skipIf(!hasTestDb)('buildStatus (DB integration, Task 7.3)', () => {
  let owner!: Pool;
  let app!: Pool;

  /** Zero every table the aggregator reads globally, so each test's assertions are exact. */
  async function wipe(): Promise<void> {
    await cleanupCalls(owner, '%');
    await owner.query('DELETE FROM dead_letter');
    await owner.query('DELETE FROM alert_events');
    await owner.query('DELETE FROM component_heartbeats');
    await owner.query('DELETE FROM daily_cost_usage WHERE day = $1', [day]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await owner.end();
    await app.end();
  });

  async function seedCall(callId: string, stage: string, status: string): Promise<void> {
    await upsertCallState(app, { callId, source: 'test-status', currentStage: stage, status });
  }

  it('maps one processing call at each stage to its DTO node (reworded keys included)', async () => {
    for (const stage of PIPELINE_STAGES) {
      await seedCall(`test-status-${stage}`, stage, 'processing');
    }
    // An unrecognized current_stage must NOT break the page.
    await seedCall('test-status-ghost', 'some-future-stage', 'processing');

    const dto = await buildStatus(app, { config: makeTestConfig(), now, logger: silentLogger });
    for (const stage of PIPELINE_STAGES) {
      const key = dbStageToDtoKey(stage)!;
      const node = dto.pipeline_nodes.find((n) => n.key === key);
      expect(node?.count, `${stage} → ${key}`).toBe(1);
    }
    expect(dto.pipeline_nodes.find((n) => n.key === 'availability_check')?.count).toBe(1);
    expect(dto.pipeline_nodes.find((n) => n.key === 'second_pii_scan')?.count).toBe(1);
    expect(dto.pipeline_nodes.find((n) => n.key === 'mark_retention_eligible')?.count).toBe(1);
  });

  it('counts completed-today only, over UTC boundaries', async () => {
    await seedCall('test-status-done', 'mark-retention-eligible', 'completed');
    await seedCall('test-status-proc', 'redact', 'processing'); // processing, not counted
    await seedCall('test-status-old', 'mark-retention-eligible', 'completed');
    await owner.query(
      `UPDATE call_state SET updated_at = now() - interval '2 days' WHERE call_id = 'test-status-old'`,
    );
    const dto = await buildStatus(app, { config: makeTestConfig(), now, logger: silentLogger });
    expect(dto.summary.calls_processed_today).toBe(1);
  });

  it('reports held-for-review total + per-reason breakdown', async () => {
    await seedCall('test-status-h1', 'redact', 'held');
    await seedCall('test-status-h2', 'classify', 'held');
    await enqueueReview(app, {
      callId: 'test-status-h1',
      heldReason: 'missing_transcript',
      slaDueAt: now,
    });
    await enqueueReview(app, {
      callId: 'test-status-h2',
      heldReason: 'classified_spam',
      slaDueAt: now,
    });
    const dto = await buildStatus(app, { config: makeTestConfig(), now, logger: silentLogger });
    expect(dto.summary.calls_held_for_review).toBe(2);
    const reasons = Object.fromEntries(
      (dto.summary.held_by_reason ?? []).map((r) => [r.held_reason, r.count]),
    );
    expect(reasons).toMatchObject({ missing_transcript: 1, classified_spam: 1 });
  });

  it('reports the dead-letter count', async () => {
    await recordDeadLetter(app, {
      errorCode: 'QUEUE_RETRY_EXHAUSTED',
      rootCauseCategory: 'QUEUE_RETRY_EXHAUSTED',
    });
    const dto = await buildStatus(app, { config: makeTestConfig(), now, logger: silentLogger });
    expect(dto.summary.dead_letter_count).toBe(1);
  });

  it('derives component states from heartbeats: healthy / broken(stale) / degraded / unknown(missing)', async () => {
    await recordHeartbeat(app, { component: 'worker' }); // fresh → healthy
    await recordHeartbeat(app, { component: 'reconciliation-cron' });
    await owner.query(
      `UPDATE component_heartbeats SET last_run_at = now() - interval '10 days' WHERE component = 'reconciliation-cron'`,
    );
    await recordHeartbeat(app, { component: 'retention-cron', status: 'degraded' });
    // webhook-receiver: no row seeded → unknown

    const dto = await buildStatus(app, { config: makeTestConfig(), now, logger: silentLogger });
    const byKey = Object.fromEntries(dto.components.map((c) => [c.key, c.state]));
    expect(byKey.worker).toBe('healthy');
    expect(byKey.reconciliation_cron).toBe('broken');
    expect(byKey.retention_cron).toBe('degraded');
    expect(byKey.webhook_receiver).toBe('unknown');
  });

  it('model kill switch (CLASSIFY_ENABLED=false) → model_paused=true and classify/extract paused', async () => {
    await seedCall('test-status-c', 'classify', 'processing');
    await seedCall('test-status-e', 'extract', 'processing');
    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: false }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.spend.model_paused).toBe(true);
    expect(dto.pipeline_nodes.find((n) => n.key === 'classify')?.state).toBe('paused');
    expect(dto.pipeline_nodes.find((n) => n.key === 'extract')?.state).toBe('paused');
  });

  it('extract kill switch pauses only the extract node (classify enabled stays healthy/idle)', async () => {
    await seedCall('test-status-c2', 'classify', 'processing');
    await seedCall('test-status-e2', 'extract', 'processing');
    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: false }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.spend.model_paused).toBe(true); // extract paused ⇒ model_paused true
    expect(dto.pipeline_nodes.find((n) => n.key === 'extract')?.state).toBe('paused');
    expect(dto.pipeline_nodes.find((n) => n.key === 'classify')?.state).toBe('healthy');
  });

  it('model enabled, spend below cap → model_paused=false; over cap → true', async () => {
    const config = makeTestConfig({
      CLASSIFY_ENABLED: true,
      EXTRACT_ENABLED: true,
      DAILY_MODEL_COST_CAP_USD: 10,
    });
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 3 });
    let dto = await buildStatus(app, { config, now, logger: silentLogger });
    expect(dto.summary.spend.spent_usd).toBe(3);
    expect(dto.summary.spend.model_paused).toBe(false);

    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 8 }); // total 11 > 10
    dto = await buildStatus(app, { config, now, logger: silentLogger });
    expect(dto.summary.spend.model_paused).toBe(true);
  });

  it('an active cost-warning alert with spend below cap does NOT pause the model (Task 7.2 non-blocking)', async () => {
    const config = makeTestConfig({
      CLASSIFY_ENABLED: true,
      EXTRACT_ENABLED: true,
      DAILY_MODEL_COST_CAP_USD: 10,
    });
    // Spend is comfortably under the cap — the hard cap is NOT reached.
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 8 });
    // An advisory warning alert is active (medium severity, mapped to the classify stage).
    await recordAlert(app, {
      errorCode: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
      rootCauseCategory: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
      severity: 'medium',
      dedupKey: `MODEL_COST_WARNING_THRESHOLD_EXCEEDED:day:${day}`,
      failureSnapshot: { context: { stage: 'classify' } },
    });
    const dto = await buildStatus(app, { config, now, logger: silentLogger });

    // The warning never pauses the model — spend is under cap and both stages are enabled.
    expect(dto.summary.spend.model_paused).toBe(false);
    const classify = dto.pipeline_nodes.find((n) => n.key === 'classify');
    const extract = dto.pipeline_nodes.find((n) => n.key === 'extract');
    expect(classify?.state).not.toBe('paused');
    expect(extract?.state).not.toBe('paused');
  });

  it('a critical alert makes the pipeline broken, surfaces the cause, and breaks the mapped stage', async () => {
    await seedCall('test-status-r', 'redact', 'processing');
    await recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'critical',
      dedupKey: 'test-status:db',
      failureSnapshot: { context: { stage: 'redact' } },
    });
    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.pipeline_state).toBe('broken');
    expect(dto.summary.latest_issue?.error_code).toBe('DATABASE_UNAVAILABLE');
    expect(dto.summary.latest_issue?.summary).toContain('Postgres is unreachable');
    expect(dto.pipeline_nodes.find((n) => n.key === 'redact')?.state).toBe('broken');
  });

  it('auto-expires a component alert once that component reports healthy again (newer heartbeat)', async () => {
    await seedCall('test-status-x', 'store', 'processing');
    await recordAlert(app, {
      errorCode: 'DIALPAD_API_CHANGED',
      rootCauseCategory: 'DIALPAD_API_CHANGED',
      severity: 'high',
      dedupKey: 'DIALPAD_API_CHANGED:component:reconciliation-cron',
      failureSnapshot: { context: { component: 'reconciliation-cron' } },
    });
    // The incident is in the past…
    await owner.query(
      `UPDATE alert_events SET created_at = now() - interval '1 hour' WHERE dedup_key = $1`,
      ['DIALPAD_API_CHANGED:component:reconciliation-cron'],
    );
    // …and the component has since run successfully (a fresh, non-degraded heartbeat).
    await recordHeartbeat(app, { component: 'reconciliation-cron' });
    await recordHeartbeat(app, { component: 'worker' });

    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: true }),
      now,
      logger: silentLogger,
    });
    // Recovered → the banner clears; it does NOT keep showing the resolved incident.
    expect(dto.summary.latest_issue).toBeNull();
    expect(dto.summary.pipeline_state).toBe('running');
  });

  it('keeps a component alert while the component has NOT recovered (heartbeat older than the alert)', async () => {
    await recordAlert(app, {
      errorCode: 'DIALPAD_API_CHANGED',
      rootCauseCategory: 'DIALPAD_API_CHANGED',
      severity: 'high',
      dedupKey: 'DIALPAD_API_CHANGED:component:reconciliation-cron',
      failureSnapshot: { context: { component: 'reconciliation-cron' } },
    });
    await recordHeartbeat(app, { component: 'reconciliation-cron' });
    // The last successful run predates the incident → not recovered.
    await owner.query(
      `UPDATE component_heartbeats SET last_run_at = now() - interval '2 hours' WHERE component = $1`,
      ['reconciliation-cron'],
    );
    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: true }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.latest_issue?.error_code).toBe('DIALPAD_API_CHANGED');
    expect(dto.summary.pipeline_state).toBe('degraded');
  });

  it('falls through a recovered component alert to an older still-active issue', async () => {
    // An older, still-active issue that is NOT component-scoped (cannot auto-recover here).
    await recordAlert(app, {
      errorCode: 'REVIEW_QUEUE_STALLED',
      rootCauseCategory: 'REVIEW_QUEUE_STALLED',
      severity: 'high',
      dedupKey: 'REVIEW_QUEUE_STALLED:review_queue:r-1',
      failureSnapshot: { context: {} },
    });
    await owner.query(
      `UPDATE alert_events SET created_at = now() - interval '2 hours' WHERE dedup_key = $1`,
      ['REVIEW_QUEUE_STALLED:review_queue:r-1'],
    );
    // A NEWER component alert that has since recovered → must be skipped, revealing the older one.
    await recordAlert(app, {
      errorCode: 'DIALPAD_API_CHANGED',
      rootCauseCategory: 'DIALPAD_API_CHANGED',
      severity: 'high',
      dedupKey: 'DIALPAD_API_CHANGED:component:reconciliation-cron',
      failureSnapshot: { context: { component: 'reconciliation-cron' } },
    });
    await owner.query(
      `UPDATE alert_events SET created_at = now() - interval '1 hour' WHERE dedup_key = $1`,
      ['DIALPAD_API_CHANGED:component:reconciliation-cron'],
    );
    await recordHeartbeat(app, { component: 'reconciliation-cron' }); // fresh → recovered

    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: true }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.latest_issue?.error_code).toBe('REVIEW_QUEUE_STALLED');
  });

  it('healthy snapshot → running when model enabled, no alerts, spend under cap', async () => {
    await seedCall('test-status-p', 'store', 'processing');
    await recordHeartbeat(app, { component: 'worker' });
    const dto = await buildStatus(app, {
      config: makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: true }),
      now,
      logger: silentLogger,
    });
    expect(dto.summary.pipeline_state).toBe('running');
    expect(dto.summary.spend.model_paused).toBe(false);
    expect(dto.pipeline_nodes.find((n) => n.key === 'store')?.state).toBe('healthy');
  });
});
