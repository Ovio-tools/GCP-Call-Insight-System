import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { repositories } from '../../src/db/index.js';
import type { PipelineJobData } from '../../src/queue/pipeline-queue.js';
import { createPgIngestSink } from '../../src/dialpad/webhook/sink.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const CALL_ID = 'test-dialpad-sink-1';
const PATTERN = 'test-dialpad-sink-%';

/**
 * The Postgres-backed ingest sink writes call_state (non-PII source_metadata) and a purgeable
 * raw_webhook_events row with the supplied clock stamps, then enqueues. Redis is avoided with a
 * stub queue so this asserts the DB contract without a broker.
 */
describe.skipIf(!hasTestDb)('createPgIngestSink', () => {
  let owner!: Pool;
  let app!: Pool;
  const added: string[] = [];
  const stubQueue = {
    add: (_name: string, data: PipelineJobData) => {
      added.push(data.callId);
      return Promise.resolve({});
    },
  } as unknown as Queue<PipelineJobData>;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM raw_webhook_events WHERE source = 'dialpad-webhook'`);
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('seeds call_state, writes an audit row with clock stamps, and enqueues once', async () => {
    const config = makeTestConfig();
    const sink = createPgIngestSink({ pool: app, queue: stubQueue, config });
    const stamp = new Date('2026-07-01T12:00:00.000Z');

    await sink.ingest({
      callId: CALL_ID,
      sourceMetadata: { direction: 'inbound', state: 'connected' },
      auditPayload: { event_id: 'id:e1', call_id: CALL_ID, phone_hmac: ['abc'] },
      receivedAt: stamp,
      retentionEligibleAt: stamp,
    });

    const state = await repositories.callState.getCallState(app, CALL_ID);
    expect(state?.current_stage).toBe('metadata-pre-filter');
    expect(state?.source_metadata).toEqual({ direction: 'inbound', state: 'connected' });

    const audit = await owner.query<{ received_at: Date; retention_eligible_at: Date | null }>(
      `SELECT received_at, retention_eligible_at FROM raw_webhook_events
        WHERE source = 'dialpad-webhook' AND payload->>'call_id' = $1`,
      [CALL_ID],
    );
    expect(audit.rows).toHaveLength(1);
    const auditRow = audit.rows[0] as { received_at: Date; retention_eligible_at: Date | null };
    expect(auditRow.received_at.getTime()).toBe(stamp.getTime());
    expect(auditRow.retention_eligible_at?.getTime()).toBe(stamp.getTime());

    expect(added).toEqual([CALL_ID]);
  });

  it('does NOT rewind or clobber an in-flight call on a repeat delivery (seed-if-absent)', async () => {
    const config = makeTestConfig();
    const sink = createPgIngestSink({ pool: app, queue: stubQueue, config });
    const callId = 'test-dialpad-sink-inflight';
    const stamp = new Date('2026-07-02T09:00:00.000Z');

    // First delivery seeds the call; the worker then advances it well past stage 0.
    await sink.ingest({
      callId,
      sourceMetadata: { direction: 'inbound', state: 'ringing' },
      auditPayload: { event_id: 'id:first', call_id: callId },
      receivedAt: stamp,
      retentionEligibleAt: stamp,
    });
    await repositories.callState.advanceStage(app, {
      callId,
      toStage: 'classify',
      status: 'processing',
      logEntry: { stage: 'classify', outcome: 'continue' },
    });

    // A second, distinct Dialpad event for the same call_id arrives while it is mid-pipeline.
    await sink.ingest({
      callId,
      sourceMetadata: { direction: 'inbound', state: 'hangup' },
      auditPayload: { event_id: 'id:second', call_id: callId },
      receivedAt: stamp,
      retentionEligibleAt: stamp,
    });

    // The in-flight stage and original metadata must survive — no rewind to metadata-pre-filter,
    // no source_metadata clobber (that was the upsert-vs-seed bug).
    const state = await repositories.callState.getCallState(app, callId);
    expect(state?.current_stage).toBe('classify');
    expect(state?.status).toBe('processing');
    expect(state?.source_metadata).toEqual({ direction: 'inbound', state: 'ringing' });
  });
});
