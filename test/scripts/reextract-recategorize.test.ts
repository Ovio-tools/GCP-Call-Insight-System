import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { JobsOptions } from 'bullmq';
import type { ServiceCategory } from '../../src/db/enums.js';
import {
  DEFAULT_REEXTRACT_CATEGORIES,
  findReextractableCalls,
  parseArgs,
  reextractCalls,
} from '../../src/scripts/reextract-recategorize.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { upsertStructuredKnowledge } from '../../src/db/repositories/structured-knowledge-repo.js';
import { upsertExtractionCandidate } from '../../src/db/repositories/extraction-candidates-repo.js';
import {
  reextractJobId,
  type PipelineJobData,
  type ReprocessQueue,
} from '../../src/queue/pipeline-queue.js';
import { STATUS_PROCESSING } from '../../src/pipeline/stages.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';

const PATTERN = 'test-rx-%';
const config = makeTestConfig();

/** Capturing fake queue — no Redis; optionally throws to exercise the revert-on-failure path. */
function fakeQueue(throwOn?: string): {
  queue: ReprocessQueue;
  calls: { data: PipelineJobData; opts: JobsOptions & { jobId: string } }[];
} {
  const calls: { data: PipelineJobData; opts: JobsOptions & { jobId: string } }[] = [];
  return {
    calls,
    queue: {
      add(_name, data, opts) {
        if (throwOn && data.callId === throwOn) return Promise.reject(new Error('redis down'));
        calls.push({ data, opts });
        return Promise.resolve(undefined);
      },
    },
  };
}

/** Seed a COMPLETED, re-extractable call: state completed@final, a live clean transcript, and a
 * structured_knowledge row in `category`. No extraction_candidate row (that is fine — the scope
 * only EXCLUDES a HARD-DELETED candidate). */
async function seedCompleted(pool: Pool, callId: string, category: ServiceCategory): Promise<void> {
  await upsertCallState(pool, {
    callId,
    source: 'dialpad-webhook',
    currentStage: 'extract',
    status: STATUS_PROCESSING,
  });
  // Move it to the real terminal state a finished call has.
  await pool.query(
    `UPDATE call_state SET status='completed', current_stage='mark-retention-eligible' WHERE call_id=$1`,
    [callId],
  );
  await upsertCleanTranscript(pool, {
    callId,
    redactedText: 'a redacted transcript body',
    redactionRiskScore: 0,
    redactionReasons: [],
  });
  await upsertStructuredKnowledge(pool, {
    callId,
    callIntent: 'existing_job',
    serviceCategory: category,
    problemStatement: 'pump problem',
    urgency: 'routine',
    sentiment: 'neutral',
    schemaVersion: 1,
    promptVersion: 'extract-v2',
    modelId: 'test-model',
  });
}

describe('parseArgs', () => {
  it('defaults to the safe category subset with no dry-run', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      scope: { categories: DEFAULT_REEXTRACT_CATEGORIES },
    });
  });

  it('--dry-run flags a preview', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('--all clears the category filter (every completed call)', () => {
    expect(parseArgs(['--all']).scope).toEqual({ categories: [] });
  });

  it('--categories=a,b overrides with an explicit trimmed set', () => {
    expect(parseArgs(['--categories=grinder_pump, sewer_or_septic ,']).scope).toEqual({
      categories: ['grinder_pump', 'sewer_or_septic'],
    });
  });
});

describe.skipIf(!hasTestDb)('findReextractableCalls', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterEach(async () => {
    await cleanupCalls(pool, PATTERN);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('includes a completed call with a live clean transcript and no hard-deleted candidate', async () => {
    await seedCompleted(pool, 'test-rx-in', 'sump_pump_or_drainage');
    const ids = await findReextractableCalls(pool);
    expect(ids).toContain('test-rx-in');
  });

  it('excludes a completed call whose clean transcript was purged (soft/hard-deleted)', async () => {
    await seedCompleted(pool, 'test-rx-purged', 'sump_pump_or_drainage');
    await pool.query(`UPDATE clean_transcripts SET soft_deleted_at = now() WHERE call_id=$1`, [
      'test-rx-purged',
    ]);
    const ids = await findReextractableCalls(pool);
    expect(ids).not.toContain('test-rx-purged');
  });

  it('excludes a completed call whose extraction_candidate was hard-deleted by retention', async () => {
    await seedCompleted(pool, 'test-rx-hd', 'sump_pump_or_drainage');
    await upsertExtractionCandidate(pool, {
      callId: 'test-rx-hd',
      callIntent: 'existing_job',
      serviceCategory: 'sump_pump_or_drainage',
      problemStatement: 'pump',
      urgency: 'routine',
      sentiment: 'neutral',
      schemaVersion: 1,
      promptVersion: 'extract-v2',
      modelId: 'test-model',
    });
    await pool.query(`UPDATE extraction_candidates SET hard_deleted_at = now() WHERE call_id=$1`, [
      'test-rx-hd',
    ]);
    const ids = await findReextractableCalls(pool);
    expect(ids).not.toContain('test-rx-hd');
  });

  it('excludes a call that is not completed (still processing / held)', async () => {
    await upsertCallState(pool, {
      callId: 'test-rx-proc',
      source: 'dialpad-webhook',
      currentStage: 'extract',
      status: STATUS_PROCESSING,
    });
    const ids = await findReextractableCalls(pool);
    expect(ids).not.toContain('test-rx-proc');
  });

  it('honors a categories filter (only the named current categories)', async () => {
    await seedCompleted(pool, 'test-rx-sump', 'sump_pump_or_drainage');
    await seedCompleted(pool, 'test-rx-heater', 'water_heater');
    const ids = await findReextractableCalls(pool, { categories: ['sump_pump_or_drainage'] });
    expect(ids).toContain('test-rx-sump');
    expect(ids).not.toContain('test-rx-heater');
  });
});

describe.skipIf(!hasTestDb)('reextractCalls', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterEach(async () => {
    await cleanupCalls(pool, PATTERN);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function stateOf(callId: string): Promise<{ status: string; current_stage: string }> {
    const { rows } = await pool.query<{ status: string; current_stage: string }>(
      `SELECT status, current_stage FROM call_state WHERE call_id=$1`,
      [callId],
    );
    return rows[0]!;
  }

  it('dry-run reports the eligible count and enqueues nothing, leaving state completed', async () => {
    await seedCompleted(pool, 'test-rx-dry', 'sump_pump_or_drainage');
    const { queue, calls } = fakeQueue();
    const summary = await reextractCalls(
      { pool, queue, config },
      { runId: 'run-1', dryRun: true, categories: ['sump_pump_or_drainage'] },
    );
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
    expect(summary.enqueued).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await stateOf('test-rx-dry')).toEqual({
      status: 'completed',
      current_stage: 'mark-retention-eligible',
    });
  });

  it('resets each eligible call to processing@extract and enqueues it once with the re-extract id', async () => {
    await seedCompleted(pool, 'test-rx-go', 'sump_pump_or_drainage');
    const { queue, calls } = fakeQueue();
    const summary = await reextractCalls(
      { pool, queue, config },
      { runId: 'run-2', categories: ['sump_pump_or_drainage'] },
    );
    expect(summary.enqueued).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ callId: 'test-rx-go' });
    expect(calls[0]!.opts.jobId).toBe(reextractJobId('test-rx-go', 'run-2'));
    expect(await stateOf('test-rx-go')).toEqual({
      status: 'processing',
      current_stage: 'extract',
    });
  });

  it('reverts the call to completed and rethrows when the enqueue fails (consistent for a re-run)', async () => {
    await seedCompleted(pool, 'test-rx-fail', 'sump_pump_or_drainage');
    const { queue } = fakeQueue('test-rx-fail');
    await expect(
      reextractCalls(
        { pool, queue, config },
        { runId: 'run-3', categories: ['sump_pump_or_drainage'] },
      ),
    ).rejects.toThrow(/redis down/i);
    expect(await stateOf('test-rx-fail')).toEqual({
      status: 'completed',
      current_stage: 'mark-retention-eligible',
    });
  });
});
