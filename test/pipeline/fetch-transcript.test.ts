import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { DialpadError, type DialpadClient } from '../../src/dialpad/client/index.js';
import {
  createFetchTranscriptHandler,
  createTranscriptAvailabilityHandler,
} from '../../src/pipeline/fetch-transcript.js';
import { buildProductionStageHandlers } from '../../src/pipeline/handlers.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import type { StageContext } from '../../src/pipeline/stages.js';
import {
  getCallState,
  skipCall,
  upsertCallState,
} from '../../src/db/repositories/call-state-repo.js';
import { getTranscript, putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-ft-%';

/** A Dialpad client stub: fetchTranscript is a spy (returned separately so assertions on it
 * don't trip the unbound-method lint); list is unused here. */
function fakeClient(fetch: DialpadClient['fetchTranscript']): {
  client: DialpadClient;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn(fetch);
  return {
    client: {
      fetchTranscript: fetchSpy,
      listRecentlyConcludedCalls: vi.fn(() => Promise.resolve({ calls: [] })),
    },
    fetchSpy,
  };
}

/** A DelayedRetryQueue stub capturing the delayed re-enqueues the handler schedules. */
function fakeQueue() {
  const add = vi.fn((_name: string, _data: unknown, _opts: unknown) => Promise.resolve());
  return { add };
}

function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
}

describe.skipIf(!hasTestDb)('fetch-transcript stage', () => {
  let owner!: Pool;
  let app!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  const seedProcessing = (callId: string, stage = 'fetch-transcript'): Promise<unknown> =>
    upsertCallState(app, { callId, source: 'test', currentStage: stage, status: 'processing' });

  const countRows = async (table: string, callId: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };

  const alertCount = async (code: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_events WHERE error_code = $1`,
      [code],
    );
    return Number(r.rows[0]?.n);
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await owner.query(
      `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
       VALUES (1, 'active', 'local:test', 'kek-test') ON CONFLICT (key_version) DO NOTHING`,
    );
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(`DELETE FROM alert_events WHERE error_code LIKE 'DIALPAD_%'`);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  function handlers(client: DialpadClient, queue = fakeQueue(), overrides = {}) {
    // buildProductionStageHandlers now also constructs the redact handler (Task 4.1),
    // which fail-fast-validates its value-hash key at factory time.
    const config = makeTestConfig({
      DIALPAD_API_KEY: 'k',
      REDACTION_VALUE_HASH_KEY: Buffer.alloc(32, 7).toString('base64'),
      ...overrides,
    });
    return {
      set: buildProductionStageHandlers({ client, keyProvider, queue, config }),
      queue,
      config,
    };
  }

  it('stores a ready transcript through the encrypted helper and advances', async () => {
    const callId = 'test-ft-ready';
    await seedProcessing(callId);
    const { client, fetchSpy } = fakeClient(() =>
      Promise.resolve({ kind: 'ready', transcript: 'RAW BODY' }),
    );
    const { set } = handlers(client);

    await runPipeline(app, callId, createRootLogger({ level: 'silent' }), set);

    // Advanced past fetch-transcript (the transcript is stored, encrypted at rest). The
    // pipeline then parks at the now-real classify stage, which defers while CLASSIFY_ENABLED
    // is false (the test config default) — so the call is still `processing`, not `completed`,
    // and never reached fetch-transcript twice.
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('processing');
    expect(state?.current_stage).toBe('classify');
    expect(await getTranscript(app, keyProvider, callId)).toBe('RAW BODY');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('defers with a colon-free delayed retry job when the transcript is not ready', async () => {
    const callId = 'test-ft-defer';
    await seedProcessing(callId);
    const { client } = fakeClient(() => Promise.resolve({ kind: 'not_ready' }));
    // Large window so it defers rather than holds.
    const { set, queue } = handlers(client, fakeQueue(), {
      DIALPAD_TRANSCRIPT_WAIT_MAX_MS: 1_800_000,
      DIALPAD_TRANSCRIPT_POLL_MS: 60_000,
    });

    await runPipeline(app, callId, createRootLogger({ level: 'silent' }), set);

    // Stayed at fetch-transcript, no failure, no hold, no transcript stored.
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('processing');
    expect(state?.current_stage).toBe('fetch-transcript');
    expect(state?.transcript_wait_started_at).not.toBeNull();
    expect(await countRows('review_queue', callId)).toBe(0);
    expect(await countRows('raw_transcripts', callId)).toBe(0);

    // A delayed retry was scheduled with a distinct, BullMQ-safe (no ':') job id.
    expect(queue.add).toHaveBeenCalledTimes(1);
    const opts = queue.add.mock.calls[0]?.[2] as { jobId: string; delay: number };
    expect(opts.delay).toBe(60_000);
    expect(opts.jobId).toContain('-wait-');
    expect(opts.jobId).not.toContain(':');
  });

  it('holds with missing_transcript + emits DIALPAD_TRANSCRIPT_MISSING once the window passes', async () => {
    const callId = 'test-ft-missing';
    await seedProcessing(callId);
    const { client } = fakeClient(() => Promise.resolve({ kind: 'not_ready' }));
    // Zero window ⇒ the first not-ready observation is already past the deadline.
    const { set, queue } = handlers(client, fakeQueue(), { DIALPAD_TRANSCRIPT_WAIT_MAX_MS: 0 });

    await runPipeline(app, callId, createRootLogger({ level: 'silent' }), set);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held');
    expect(state?.current_stage).toBe('fetch-transcript');
    // Held for review with the right reason, one alert, and NO retry scheduled.
    const reviews = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toEqual([{ held_reason: 'missing_transcript' }]);
    expect(await alertCount('DIALPAD_TRANSCRIPT_MISSING')).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does NOT fetch a transcript for a pre-filter-dropped (skipped) call', async () => {
    const callId = 'test-ft-skipped';
    // Seed at the pre-filter and drop it, exactly as the metadata stage would.
    await seedProcessing(callId, 'metadata-pre-filter');
    await skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' });

    const { client, fetchSpy } = fakeClient(() =>
      Promise.resolve({ kind: 'ready', transcript: 'x' }),
    );
    const { set } = handlers(client);

    await runPipeline(app, callId, createRootLogger({ level: 'silent' }), set);

    // Terminal skipped guard makes it a no-op; the Dialpad API is never touched.
    expect(fetchSpy).not.toHaveBeenCalled();
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('skipped');
    expect(state?.current_stage).toBe('metadata-pre-filter');
  });

  it.each([
    ['auth', 'DIALPAD_AUTH_FAILED', 401],
    ['rate_limited', 'DIALPAD_RATE_LIMITED', 429],
    ['api_changed', 'DIALPAD_API_CHANGED', 400],
  ] as const)(
    'on a %s failure: persists the alert, propagates, and creates NO review_queue row',
    async (kind, code, status) => {
      const callId = `test-ft-${kind}`;
      await seedProcessing(callId);
      const { client } = fakeClient(() =>
        Promise.reject(new DialpadError(kind, { endpoint: 'transcripts', status, attempts: 1 })),
      );
      const { set } = handlers(client);

      await expect(
        runPipeline(app, callId, createRootLogger({ level: 'silent' }), set),
      ).rejects.toBeInstanceOf(Error);

      expect(await alertCount(code)).toBe(1);
      expect(await countRows('review_queue', callId)).toBe(0);
      // Not advanced, not held — stays recoverable at fetch-transcript for BullMQ retry.
      const state = await getCallState(app, callId);
      expect(state?.status).toBe('processing');
      expect(state?.current_stage).toBe('fetch-transcript');
    },
  );

  it('emits NO specific alert for a transient (unavailable) failure — the dead-letter path covers it', async () => {
    const callId = 'test-ft-unavailable';
    await seedProcessing(callId);
    const { client } = fakeClient(() =>
      Promise.reject(
        new DialpadError('unavailable', { endpoint: 'transcripts', status: 503, attempts: 5 }),
      ),
    );
    const { set } = handlers(client);

    await expect(
      runPipeline(app, callId, createRootLogger({ level: 'silent' }), set),
    ).rejects.toBeInstanceOf(Error);

    expect(await alertCount('DIALPAD_API_CHANGED')).toBe(0);
    expect(await alertCount('DIALPAD_AUTH_FAILED')).toBe(0);
  });

  it('never logs transcript content on the ready path', async () => {
    const callId = 'test-ft-privacy';
    await seedProcessing(callId);
    const planted = 'CUSTOMER_SAID_secret_9999 SSN 111-22-3333';
    const { client } = fakeClient(() => Promise.resolve({ kind: 'ready', transcript: planted }));
    const { lines, logger } = collectingLogger();

    const handler = createFetchTranscriptHandler({
      client,
      keyProvider,
      queue: fakeQueue(),
      config: makeTestConfig({ DIALPAD_API_KEY: 'k' }),
    });
    const ctx: StageContext = { callId, stage: 'fetch-transcript', logger, pool: app };
    await handler(ctx);

    // Stored (encrypted) but never written to a log line.
    expect(await getTranscript(app, keyProvider, callId)).toBe(planted);
    expect(lines.join('')).not.toContain('secret_9999');
    expect(lines.join('')).not.toContain('111-22-3333');
  });

  describe('transcript-availability gate', () => {
    const config = makeTestConfig({ DIALPAD_API_KEY: 'k' });

    it('continues when an encrypted transcript is present', async () => {
      const callId = 'test-ft-avail-ok';
      await seedProcessing(callId, 'transcript-availability');
      await putTranscript(app, keyProvider, { callId, transcript: 'present' });
      const { logger } = collectingLogger();

      const result = await createTranscriptAvailabilityHandler({ config })({
        callId,
        stage: 'transcript-availability',
        logger,
        pool: app,
      });
      expect(result).toEqual({ action: 'continue' });
      expect(await alertCount('DIALPAD_TRANSCRIPT_MISSING')).toBe(0);
    });

    it('holds AND emits exactly one deduped alert when the transcript is unexpectedly absent', async () => {
      const callId = 'test-ft-avail-missing';
      await seedProcessing(callId, 'transcript-availability');
      const { logger } = collectingLogger();
      const gate = createTranscriptAvailabilityHandler({ config });
      const ctx = { callId, stage: 'transcript-availability' as const, logger, pool: app };

      expect(await gate(ctx)).toMatchObject({ action: 'hold', reason: 'missing_transcript' });
      // Re-running the gate must not create a duplicate active alert (shared dedup key).
      expect(await gate(ctx)).toMatchObject({ action: 'hold', reason: 'missing_transcript' });
      expect(await alertCount('DIALPAD_TRANSCRIPT_MISSING')).toBe(1);
    });
  });
});
