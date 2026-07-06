import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';
import { testSlaMinutesFor } from '../_config.js';
import {
  createPgBackfillInlineIngest,
  createPgBackfillQueueIngest,
} from '../../src/backfill/ingest.js';
import { makeTestConfig } from '../_config.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { getCallState } from '../../src/db/repositories/call-state-repo.js';
import type { PipelineJobData } from '../../src/queue/pipeline-queue.js';
import type { RecentCall } from '../../src/dialpad/client/index.js';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

describe.skipIf(!hasTestDb)('backfill redaction fail-closed (privacy boundary)', () => {
  let owner!: Pool;
  let app!: Pool;
  const PREFIX = 'bf-fc-';
  const config = makeTestConfig();

  async function count(table: string, callId: string): Promise<number> {
    const r = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return r.rows[0]?.count ?? 0;
  }

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

  it('the production ingest only seeds + tracks + enqueues — it never redacts or stores content', async () => {
    const call: RecentCall = { callId: `${PREFIX}prod`, startedAt: 1000, endedAt: 2000 };
    const added: string[] = [];
    const fakeQueue = {
      add: (_name: string, data: PipelineJobData) => {
        added.push(data.callId);
        return Promise.resolve();
      },
    } as unknown as Queue<PipelineJobData>;

    const ingest = createPgBackfillQueueIngest({
      pool: app,
      queue: fakeQueue,
      config,
      runId: await seedRun(),
    });
    await ingest.ingestGap(call);

    // Seeded + tracked + enqueued; NOTHING written to any content/redaction store by the ingest.
    expect((await getCallState(app, call.callId))?.source).toBe('dialpad-backfill');
    expect(added).toEqual([call.callId]);
    expect(await count('raw_transcripts', call.callId)).toBe(0);
    expect(await count('clean_transcripts', call.callId)).toBe(0);
    expect(await count('structured_knowledge', call.callId)).toBe(0);
  });

  it('a backfill call run through runPipeline with a residual-PII redaction result is HELD, not stored', async () => {
    const callId = `${PREFIX}held`;
    // A redact stage that fails closed (residual PII) — the state machine must HOLD, not advance to
    // store. This exercises the REAL runPipeline (the privacy boundary is structurally enforced).
    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      redact: () =>
        Promise.resolve({
          action: 'hold',
          reason: 'residual_pii_detected',
          errorCode: 'REDACTION_LOW_CONFIDENCE',
        }),
    };

    const ingest = createPgBackfillInlineIngest({
      pool: app,
      runId: await seedRun(),
      runCall: (id) =>
        runPipeline(app, id, noopLogger, { handlers, slaMinutesFor: testSlaMinutesFor }),
    });
    await ingest.ingestGap({ callId, startedAt: 1000, endedAt: 2000 });

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held'); // set aside for a person, not completed
    expect(await count('structured_knowledge', callId)).toBe(0); // nothing stored
  });

  async function seedRun(): Promise<string> {
    const r = await app.query<{ id: string }>(
      `INSERT INTO backfill_runs (window_start, window_end, status)
       VALUES (now() - interval '1 day', now(), 'running') RETURNING id`,
    );
    return r.rows[0]!.id;
  }
});
