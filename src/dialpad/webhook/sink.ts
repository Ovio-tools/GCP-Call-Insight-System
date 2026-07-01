import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Config } from '../../config/schema.js';
import type { JsonValue } from '../../db/types.js';
import { repositories } from '../../db/index.js';
import { enqueueCall, type PipelineJobData } from '../../queue/pipeline-queue.js';
import { PIPELINE_STAGES, STATUS_PROCESSING } from '../../pipeline/stages.js';

/**
 * The side effect of a verified Dialpad webhook, behind a port so the route is testable without a
 * real Postgres/Redis. A verified event is turned into exactly: an idempotent `call_state` upsert
 * (seeding the Task 3.1 pre-filter), a minimized `raw_webhook_events` audit row, and one ingest
 * job keyed by call_id. No transcript fetch or model call — that is the worker's job.
 */
export interface DialpadIngestEvent {
  callId: string;
  /** Non-PII metadata for `call_state.source_metadata` (indefinitely retained). */
  sourceMetadata: Record<string, JsonValue>;
  /** Minimized allowlist (+ hashed phone/name) for the purgeable audit row. */
  auditPayload: Record<string, JsonValue>;
  receivedAt: Date;
  retentionEligibleAt: Date;
}

export interface DialpadIngestSink {
  ingest(event: DialpadIngestEvent): Promise<void>;
}

/** The source tag recorded on `call_state` and `raw_webhook_events` for webhook-ingested calls. */
export const DIALPAD_WEBHOOK_SOURCE = 'dialpad-webhook';

/**
 * Postgres + BullMQ implementation. Order: seed `call_state` (so the pre-filter has input) →
 * write the audit row → enqueue. The upsert is idempotent on call_id and the enqueue collapses
 * duplicates by call_id, so a retried delivery updates rather than duplicates.
 */
export function createPgIngestSink(deps: {
  pool: Pool;
  queue: Queue<PipelineJobData>;
  config: Config;
}): DialpadIngestSink {
  const { pool, queue, config } = deps;
  return {
    async ingest(event: DialpadIngestEvent): Promise<void> {
      await repositories.callState.upsertCallState(pool, {
        callId: event.callId,
        source: DIALPAD_WEBHOOK_SOURCE,
        sourceMetadata: event.sourceMetadata,
        currentStage: PIPELINE_STAGES[0],
        status: STATUS_PROCESSING,
      });
      await repositories.rawWebhookEvents.insertWebhookEvent(pool, {
        source: DIALPAD_WEBHOOK_SOURCE,
        payload: event.auditPayload,
        signatureStatus: 'valid',
        receivedAt: event.receivedAt,
        retentionEligibleAt: event.retentionEligibleAt,
      });
      await enqueueCall(queue, event.callId, config);
    },
  };
}
