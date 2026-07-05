import { describe, expect, it } from 'vitest';
import type { JobsOptions } from 'bullmq';
import {
  enqueueReprocess,
  jobIdForCall,
  reprocessJobId,
  type PipelineJobData,
  type ReprocessQueue,
} from '../../src/queue/pipeline-queue.js';
import { makeTestConfig } from '../_config.js';

/** Capturing fake queue — no Redis needed to assert the reprocess job id + payload. */
function makeFakeQueue(): {
  queue: ReprocessQueue;
  calls: { name: string; data: PipelineJobData; opts: JobsOptions & { jobId: string } }[];
} {
  const calls: { name: string; data: PipelineJobData; opts: JobsOptions & { jobId: string } }[] =
    [];
  return {
    calls,
    queue: {
      add(name, data, opts) {
        calls.push({ name, data, opts });
        return Promise.resolve(undefined);
      },
    },
  };
}

describe('enqueueReprocess (Task 6.2)', () => {
  const config = makeTestConfig();

  it('uses a review-scoped job id distinct from the base call job id', () => {
    const base = jobIdForCall('call-1');
    const id = reprocessJobId('call-1', 'review-abc');
    expect(id).toBe(`${base}-reprocess-review-abc`);
    expect(id).not.toBe(base); // never dedups against a retained completed base job
    expect(id).not.toContain(':'); // clean token — BullMQ rejects ':'
  });

  it('enqueues the pipeline job with the reprocess job id and the original call_id payload', async () => {
    const { queue, calls } = makeFakeQueue();
    await enqueueReprocess(queue, 'call-1', config, 'review-abc');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ callId: 'call-1' });
    expect(calls[0]!.opts.jobId).toBe(reprocessJobId('call-1', 'review-abc'));
    expect(calls[0]!.opts.attempts).toBe(config.WORKER_MAX_ATTEMPTS);
  });
});
