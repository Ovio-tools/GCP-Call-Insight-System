import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import type { DialpadClient } from '../../src/dialpad/client/index.js';
import { createFetchTranscriptHandler } from '../../src/pipeline/fetch-transcript.js';
import { storeHandler } from '../../src/pipeline/store.js';
import { runPipeline } from '../_run-pipeline.js';
import {
  defaultStageHandlers,
  type StageContext,
  type StageHandlers,
} from '../../src/pipeline/stages.js';
import { getCallState, upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import {
  markPiiScanPassed,
  upsertExtractionCandidate,
} from '../../src/db/repositories/extraction-candidates-repo.js';
import type { ExtractionCandidateInsert } from '../../src/db/schemas/extraction-candidates.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from '../db/_pg.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawAppPool,
  seedKeyVersion,
} from '../db/_dal.js';

/**
 * End-to-end regression guard for the call-leg dedup fix (branch `task/dedupe-call-legs`).
 *
 * One Dialpad conversation is listed by reconciliation as multiple "legs", each with its own
 * `call_id`. At the `fetch-transcript` stage the transcript response carries a canonical
 * `call_id` (`canonicalCallId`) that is identical across legs. A leg whose id differs from the
 * canonical id is DROPPED before any model work (`duplicate_call_leg`), after ensuring the
 * canonical call is seeded + enqueued. So two legs collapse to one durable
 * `structured_knowledge` record — no duplicate Knowledge-base rows.
 *
 * This test drives the FULL pipeline for both legs through the real fetch-transcript handler
 * (the code under test) and the real store handler (the durable write), with the model stages
 * (classify/extract) faked as spies so the canonical leg produces exactly one record and the
 * dropped leg is provably never given to a model.
 */

const PATTERN = 'dedup-%';
const LEG = 'dedup-leg-a';
const CANONICAL = 'dedup-master';

const keyProvider = new LocalKeyProvider({
  masterKey: Buffer.alloc(DEK_BYTES, 0x0d),
  activeKeyVersion: 1,
});

/** A full valid extraction candidate the faked extract stage seeds for the canonical call, so
 *  the real store handler has something verified to copy into structured_knowledge. */
function baseCandidate(callId: string): ExtractionCandidateInsert {
  return {
    callId,
    callIntent: 'new_booking',
    serviceCategory: 'water_heater',
    problemStatement: 'no hot water',
    symptoms: ['cold water only'],
    customerLanguage: ['my water heater is leaking'],
    locationInHome: 'basement',
    accessOrSchedulingNotes: null,
    priorAttempts: null,
    urgency: 'routine',
    concerns: [],
    sentiment: 'neutral',
    acquisitionSource: null,
    competitorMentions: [],
    schemaVersion: 1,
    promptVersion: 'extract-v1',
    modelId: 'm-test',
  };
}

/** A Dialpad client stub whose fetchTranscript, for ANY leg id, returns a ready transcript
 *  reporting the SAME canonical id — exactly the "one conversation, many legs" shape. */
function fakeClient(canonicalCallId: string): DialpadClient {
  return {
    fetchTranscript: vi.fn(() =>
      Promise.resolve({
        kind: 'ready' as const,
        transcript: 'Caller: no hot water.',
        canonicalCallId,
      }),
    ),
    listRecentlyConcludedCalls: vi.fn(() => Promise.resolve({ calls: [] })),
  };
}

describe.skipIf(!hasTestDb || !hasRawTestDb)('call-leg dedup — two legs collapse to one', () => {
  let owner!: Pool;
  let app!: Pool;
  // DB-B (raw store): raw_transcripts + token_vault live only here.
  let rawOwner!: Pool;
  let rawApp!: Pool;
  const silent = createRootLogger({ level: 'silent' });
  const config = makeTestConfig({ DIALPAD_API_KEY: 'k' });

  // Spies standing in for the model stages, so we can prove the dropped leg is never handed to a
  // model, while the canonical leg still produces a durable record.
  const enqueueSpy = vi.fn((_callId: string) => Promise.resolve());
  const classifySpy = vi.fn((_ctx: StageContext) =>
    Promise.resolve({ action: 'continue' as const }),
  );
  // The faked extract stage seeds a verified candidate for the call it runs on (canonical only),
  // mirroring how the store-stage sibling test (store.test.ts) prepares a passed candidate.
  const extractSpy = vi.fn(async (ctx: StageContext) => {
    await upsertExtractionCandidate(app, baseCandidate(ctx.callId));
    await markPiiScanPassed(app, ctx.callId);
    return { action: 'continue' as const };
  });

  /** Handler set: real fetch-transcript (the code under test) + real store (the durable write),
   *  with model stages faked. Every other stage keeps the default stub (continue). */
  let handlers: StageHandlers;

  const seedAtFirstStage = (callId: string): Promise<unknown> =>
    upsertCallState(app, {
      callId,
      source: 'reconciliation',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

  const countRows = async (table: string, callId: string, from?: Pool): Promise<number> => {
    const r = await (from ?? owner).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };

  const calledWith = (spy: ReturnType<typeof vi.fn>, callId: string): boolean =>
    spy.mock.calls.some((args) => (args[0] as StageContext | undefined)?.callId === callId);

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    owner = makePool();
    app = makeAppPool();
    rawOwner = makeRawPool();
    rawApp = makeRawAppPool();
    await seedKeyVersion(owner);

    handlers = {
      ...defaultStageHandlers,
      'fetch-transcript': createFetchTranscriptHandler({
        client: fakeClient(CANONICAL),
        keyProvider,
        queue: { add: vi.fn(() => Promise.resolve()) },
        config,
        rawPool: rawApp,
        enqueuePipelineJob: enqueueSpy,
      }),
      classify: classifySpy,
      extract: extractSpy,
      store: storeHandler,
    };
  });

  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await cleanupRawCalls(rawOwner, PATTERN);
  });

  afterAll(async () => {
    await owner.end();
    await app.end();
    await rawOwner.end();
    await rawApp.end();
  });

  it('drops the non-canonical leg pre-model and keeps only the canonical record', async () => {
    // Reconciliation listed BOTH legs of one conversation as separate calls.
    await seedAtFirstStage(LEG);
    await seedAtFirstStage(CANONICAL);

    // Run the duplicate leg first, then the canonical call (the order the worker would see them).
    await runPipeline(app, LEG, silent, handlers);
    await runPipeline(app, CANONICAL, silent, handlers);

    // 1) The duplicate leg is terminally skipped with the dedup drop_reason.
    const legState = await getCallState(app, LEG);
    expect(legState?.status).toBe('skipped');
    expect(legState?.drop_reason).toBe('duplicate_call_leg');

    // 2) The dropped leg stored NO raw transcript (dropped before the store, in DB-B).
    expect(await countRows('raw_transcripts', LEG, rawOwner)).toBe(0);

    // 3) Exactly one structured_knowledge row for the whole conversation, under the canonical id.
    expect(await countRows('structured_knowledge', LEG)).toBe(0);
    expect(await countRows('structured_knowledge', CANONICAL)).toBe(1);
    const sk = await owner.query<{ call_id: string }>(
      `SELECT call_id FROM structured_knowledge WHERE call_id LIKE $1`,
      [PATTERN],
    );
    expect(sk.rows.map((r) => r.call_id)).toEqual([CANONICAL]);

    // 4) The dropped leg did ZERO model work: no model_invocations, and neither model spy ever
    //    saw it. The canonical leg is the only one the model stages processed.
    expect(await countRows('model_invocations', LEG)).toBe(0);
    expect(calledWith(classifySpy, LEG)).toBe(false);
    expect(calledWith(extractSpy, LEG)).toBe(false);
    expect(calledWith(classifySpy, CANONICAL)).toBe(true);
    expect(calledWith(extractSpy, CANONICAL)).toBe(true);

    // The canonical call reached the end of the pipeline.
    const canonState = await getCallState(app, CANONICAL);
    expect(canonState?.status).toBe('completed');

    // The drop path made sure the canonical call would be processed (idempotent rescue enqueue).
    expect(enqueueSpy).toHaveBeenCalledWith(CANONICAL);
  });
});
