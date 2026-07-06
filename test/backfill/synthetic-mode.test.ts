import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';
import { makeTestConfig, testSlaMinutesFor } from '../_config.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, sleep, type WorkerHarness } from '../queue/_harness.js';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { runBackfill } from '../../src/backfill/run.js';
import {
  BACKFILL_SYNTHETIC_SOURCE,
  createPgBackfillInlineIngest,
} from '../../src/backfill/ingest.js';
import { loadSyntheticDialpadFixture } from '../../src/backfill/synthetic-dialpad.js';
import { BackfillError } from '../../src/backfill/errors.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import { defaultStageHandlers } from '../../src/pipeline/stages.js';
import { getCallState } from '../../src/db/repositories/call-state-repo.js';
import { countRunCalls } from '../../src/db/repositories/backfill-run-calls-repo.js';
import type { BackfillMonitor } from '../../src/heartbeat/index.js';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;
const noopMonitor: BackfillMonitor = {
  start: () => Promise.resolve(),
  recordProgress: () => undefined,
  success: () => Promise.resolve(),
  fail: () => Promise.resolve(),
  stop: () => undefined,
};

async function writeFixture(name: string, body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bf-syn-'));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(body), 'utf8');
  return path;
}

describe.skipIf(!hasTestDb)('staging synthetic backfill (inline, no shared queue)', () => {
  let owner!: Pool;
  let app!: Pool;
  const config = makeTestConfig({ NODE_ENV: 'staging', BACKFILL_DRAIN_POLL_MS: 1 });
  const FROM = Date.parse('2023-03-01T00:00:00Z');
  const TO = Date.parse('2023-03-02T00:00:00Z');
  const PREFIX = 'bf-syn-';

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanupCalls(owner, `${PREFIX}%`);
  });
  beforeEach(() => cleanupCalls(owner, `${PREFIX}%`));
  afterAll(async () => {
    await cleanupCalls(owner, `${PREFIX}%`);
    await owner.end();
    await app.end();
  });

  it('runs each call INLINE (no queue) with the fixture client, tags synthetic, drives to terminal', async () => {
    const fixturePath = await writeFixture('good.json', {
      calls: [
        { callId: `${PREFIX}1`, startedAt: FROM + 100, endedAt: FROM + 200 },
        { callId: `${PREFIX}2`, startedAt: FROM + 300, endedAt: FROM + 400 },
      ],
      transcripts: {
        [`${PREFIX}1`]: 'synthetic transcript one',
        [`${PREFIX}2`]: 'synthetic transcript two',
      },
    });
    const client = await loadSyntheticDialpadFixture(fixturePath);

    // The inline ingest takes NO BullMQ Queue at all — the synthetic path structurally cannot
    // enqueue to the shared worker queue. runCall is the FULL runPipeline state machine (stubs).
    const result = await runBackfill({
      pool: app,
      config,
      logger: noopLogger,
      window: { fromMs: FROM, toMs: TO },
      client,
      ingestFor: (runId) =>
        createPgBackfillInlineIngest({
          pool: app,
          runId,
          runCall: (callId) =>
            runPipeline(app, callId, noopLogger, {
              handlers: defaultStageHandlers,
              slaMinutesFor: testSlaMinutesFor,
            }),
        }),
      monitor: noopMonitor,
      emitCheckpointAlert: () => Promise.resolve(),
    });

    expect(result.seededTotal).toBe(2);
    expect(result.terminalCount).toBe(2);
    expect(await countRunCalls(app, result.runId)).toBe(2);
    for (const id of [`${PREFIX}1`, `${PREFIX}2`]) {
      const state = await getCallState(app, id);
      expect(state?.source).toBe(BACKFILL_SYNTHETIC_SOURCE);
      expect(state?.status).toBe('completed');
    }
  });

  it('refuses a fixture whose transcript would be not_ready BEFORE the run starts', async () => {
    const fixturePath = await writeFixture('notready.json', {
      calls: [{ callId: `${PREFIX}nr`, startedAt: FROM + 100, endedAt: FROM + 200 }],
      transcripts: { [`${PREFIX}nr`]: '' },
    });
    await expect(loadSyntheticDialpadFixture(fixturePath)).rejects.toMatchObject({
      reason: 'invalid_synthetic_fixture',
    } satisfies Partial<BackfillError>);
  });
});

describe.skipIf(!hasTestDb || !hasTestRedis)(
  'worker refuses a synthetic backfill job (R4 #1)',
  () => {
    let h!: WorkerHarness;
    const PATTERN = 'bf-synwk-%';

    beforeAll(async () => {
      await migrate('up');
    });
    beforeEach(() => {
      h = makeWorkerHarness();
    });
    afterEach(async () => {
      await cleanupCalls(h.owner, PATTERN);
      await h.close();
    });

    it('leaves a dialpad-backfill-synthetic call unprocessed (logged no-op)', async () => {
      const callId = 'bf-synwk-1';
      // Seed with the synthetic source tag directly.
      await h.owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, $2, 'metadata-pre-filter', 'processing')`,
        [callId, BACKFILL_SYNTHETIC_SOURCE],
      );
      await enqueueCall(h.queue, callId, h.config);
      const worker = h.buildWorker();
      void worker.run();
      try {
        // Give the worker time to pick up + refuse the job; it must NOT advance the call.
        await waitFor(async () => ((await h.queue.getJobCounts()).completed ?? 0) >= 1, {
          label: 'job settled',
        });
        await sleep(50);
        const state = await h.getState(callId);
        expect(state?.status).toBe('processing'); // never advanced
        expect(state?.current_stage).toBe('metadata-pre-filter');
      } finally {
        await worker.close();
      }
    });
  },
);
