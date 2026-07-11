import { describe, expect, it } from 'vitest';
import type { JobsOptions } from 'bullmq';
import {
  enqueueReextract,
  jobIdForCall,
  reextractJobId,
  reprocessJobId,
  type PipelineJobData,
  type ReprocessQueue,
} from '../../src/queue/pipeline-queue.js';
import { makeTestConfig } from '../_config.js';

/** Capturing fake queue — no Redis needed to assert the re-extract job id + payload. */
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

describe('enqueueReextract (recategorize backfill)', () => {
  const config = makeTestConfig();

  it('uses a run-scoped job id distinct from the base + reprocess job ids', () => {
    const base = jobIdForCall('call-1');
    const id = reextractJobId('call-1', 'run-xyz');
    expect(id).toBe(`${base}-reextract-run-xyz`);
    // Never dedups against a retained completed base job, nor a review reprocess job.
    expect(id).not.toBe(base);
    expect(id).not.toBe(reprocessJobId('call-1', 'run-xyz'));
    expect(id).not.toContain(':'); // clean token — BullMQ rejects ':'
  });

  it('enqueues the pipeline job with the re-extract job id and the original call_id payload', async () => {
    const { queue, calls } = makeFakeQueue();
    await enqueueReextract(queue, 'call-1', config, 'run-xyz');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ callId: 'call-1' });
    expect(calls[0]!.opts.jobId).toBe(reextractJobId('call-1', 'run-xyz'));
    expect(calls[0]!.opts.attempts).toBe(config.WORKER_MAX_ATTEMPTS);
  });
});
