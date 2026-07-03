import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { enqueueCall, type PipelineJobData } from '../queue/pipeline-queue.js';
import type { Config } from '../config/schema.js';
import { query } from '../db/sql.js';

/**
 * Testable core: the call_ids parked at a model stage by its kill switch. Parameterized by
 * `stage`/`marker` so the classify and (Task 5.2) extract requeue scripts share one query.
 *
 * A call is "parked" iff BOTH hold:
 *  - its `call_state` is still `status='processing'` at `current_stage=<stage>` (the
 *    kill-switch park leaves the row exactly there — `parkStageDisabled` never advances it), and
 *  - its LATEST `processing_log` row for the stage is the `marker` deferred reason.
 *
 * "LATEST" is load-bearing: a call parked earlier and later genuinely processed has a NEWER
 * stage log row whose reason is not the marker, and must NOT be requeued. The
 * `ORDER BY created_at DESC, id DESC` tie-break mirrors exactly the ordering
 * `parkStageDisabled` uses to decide idempotency, so the two agree on which row is latest.
 */
export async function findParkedCalls(
  pool: Pool,
  opts: { stage: string; marker: string },
): Promise<string[]> {
  const rows = await query<{ call_id: string }>(
    pool,
    `SELECT cs.call_id
       FROM call_state cs
       JOIN LATERAL (
         -- The id DESC tie-break assumes distinct created_at per row (processing_log.id is a
         -- random uuid, not monotonic, so it cannot itself order same-timestamp rows). This
         -- holds because the park marker and any later genuine stage log are always written
         -- in separate transactions, so their created_at (transaction_timestamp) differ.
         -- This per-call LATERAL subquery rides the existing processing_log_call_id_idx access
         -- path and is acceptable for this bounded, one-shot operational script.
         SELECT pl.detail->>'reason' AS reason
           FROM processing_log pl
          WHERE pl.call_id = cs.call_id AND pl.stage = $1
          ORDER BY pl.created_at DESC, pl.id DESC
          LIMIT 1
       ) latest ON true
      WHERE cs.status = 'processing'
        AND cs.current_stage = $1
        AND latest.reason = $2
      ORDER BY cs.call_id`,
    [opts.stage, opts.marker],
  );
  return rows.map((r) => r.call_id);
}

/**
 * Find the parked calls for the stage and re-enqueue each. Enqueue is idempotent —
 * `enqueueCall` keys the job by `jobIdForCall(callId)`, so a double run (or a call that
 * already has a live job) collapses to a single job. Returns the count re-enqueued. Kept
 * separate from the CLI so tests exercise it without a real Redis.
 */
export async function requeueParkedCalls(
  deps: {
    pool: Pool;
    queue: Queue<PipelineJobData>;
    config: Config;
  },
  opts: { stage: string; marker: string },
): Promise<number> {
  const callIds = await findParkedCalls(deps.pool, opts);
  for (const callId of callIds) {
    await enqueueCall(deps.queue, callId, deps.config);
  }
  return callIds.length;
}
