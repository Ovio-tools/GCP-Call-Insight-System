import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ExtractModelClient, ModelTextResult } from '../../../src/anthropic/client.js';
import { buildProductionStageHandlers } from '../../../src/pipeline/handlers.js';
import { runPipeline } from '../../_run-pipeline.js';
import type { Clock } from '../../../src/pipeline/fetch-transcript.js';
import type { DialpadClient } from '../../../src/dialpad/client/index.js';
import { DEK_BYTES, LocalKeyProvider } from '../../../src/crypto/index.js';
import { upsertCallState, getCallState } from '../../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../../src/db/repositories/clean-transcripts-repo.js';
import {
  appendLog,
  listByCall as listLogs,
} from '../../../src/db/repositories/processing-log-repo.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { utcDay } from '../../../src/model/cost.js';
import { makeTestConfig } from '../../_config.js';
import {
  hasRawTestDb,
  hasTestDb,
  makePool,
  makeRawPool,
  migrate,
  migrateRaw,
} from '../../db/_pg.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawAppPool,
  seedKeyVersion,
} from '../../db/_dal.js';

/**
 * ADR 0010 — an emergency is a LABEL, not a hold.
 *
 * This pipeline runs after the call has ended and downstream of the dispatcher, who already
 * handled anything genuinely urgent live. So a call the urgency rule escalates to `emergency`
 * must flow all the way to `structured_knowledge` carrying that label, and must NOT be parked
 * in the review queue.
 *
 * These assertions go through `runPipeline`, not the handler directly: the handler only returns
 * a StageResult — the RUNNER is what writes `review_queue` rows (`holdCall`). A zero-rows
 * assertion against a directly-invoked handler would be vacuous.
 *
 * The last case is the scope guard: holds are not disabled in general, only the emergency one.
 */

const PATTERN = 'test-emg-%';

/** Fixed clock on a UTC day no other suite uses, so daily_cost_usage rows never collide. */
const FIXED_NOW = new Date('1998-11-09T10:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock: Clock = { now: () => FIXED_NOW.getTime() };

/**
 * A schema-valid, PII-free record with EMPTY customer_language, so it needs no verbatim quote
 * and clears verbatim-pii-scan on its way to store. `urgency` is the model's own rating — the
 * deterministic rule is what may escalate it.
 */
const RECORD = {
  call_intent: 'existing_job',
  service_category: 'other',
  problem_statement: 'caller needs help with the line',
  symptoms: [],
  concerns: [],
  customer_language: [],
  competitor_mentions: [],
  location_in_home: null,
  access_or_scheduling_notes: null,
  prior_attempts: null,
  acquisition_source: null,
  urgency: 'routine',
  sentiment: 'neutral',
};

function result(over: Record<string, unknown> = {}): ModelTextResult {
  return {
    text: JSON.stringify({ ...RECORD, ...over }),
    stopReason: 'end_turn',
    inputTokens: 2000,
    outputTokens: 300,
    usagePresent: true,
  };
}

/** A Dialpad stub — extract never touches it, but buildProductionStageHandlers wants one. */
const dialpadStub: DialpadClient = {
  fetchTranscript: vi.fn(() => Promise.resolve({ kind: 'not_ready' as const })),
  listRecentlyConcludedCalls: vi.fn(() => Promise.resolve({ calls: [] })),
};

describe.skipIf(!hasTestDb || !hasRawTestDb)('extract emergency labeling (ADR 0010)', () => {
  let owner!: Pool;
  let app!: Pool;
  // DB-B: the production set ends in mark-retention-eligible, which touches raw/vault.
  let rawOwner!: Pool;
  let rawApp!: Pool;

  const silent = createRootLogger({ level: 'silent' });
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  /** Seed call_state@extract + clean_transcripts + the classify `customer` marker. */
  const seed = async (callId: string, redacted: string): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'extract',
      status: 'processing',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
    await appendLog(app, {
      callId,
      stage: 'classify',
      outcome: 'completed',
      detail: { bucket: 'customer' },
    });
  };

  /** The FULL production handler set, so a `continue` runs on through store to completion. */
  function set(model: ExtractModelClient) {
    const config = makeTestConfig({
      EXTRACT_ENABLED: true,
      REDACTION_VALUE_HASH_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    return buildProductionStageHandlers({
      client: dialpadStub,
      keyProvider,
      queue: { add: vi.fn(() => Promise.resolve()) },
      config,
      clock,
      getExtractModel: () => model,
      rawPool: rawApp,
    });
  }

  const countRows = async (table: string, callId: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };

  const storedUrgency = async (callId: string): Promise<string | undefined> => {
    const r = await owner.query<{ urgency: string }>(
      `SELECT urgency FROM structured_knowledge WHERE call_id = $1`,
      [callId],
    );
    return r.rows[0]?.urgency;
  };

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    owner = makePool();
    app = makeAppPool();
    rawOwner = makeRawPool();
    rawApp = makeRawAppPool();
    await seedKeyVersion(owner, 1);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await cleanupRawCalls(rawOwner, PATTERN);
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
    await rawOwner.end();
    await rawApp.end();
  });

  it('an emergency KEYWORD call completes to structured_knowledge with urgency=emergency and no review row', async () => {
    const callId = 'test-emg-keyword';
    await seed(callId, 'Caller: I smell a gas leak in the kitchen and need someone out.');
    await runPipeline(
      app,
      callId,
      silent,
      set({ extract: vi.fn(() => Promise.resolve(result())) }),
    );

    // The whole point: it reached the knowledge base, labeled, unparked.
    expect(await storedUrgency(callId)).toBe('emergency');
    expect(await countRows('review_queue', callId)).toBe(0);
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('completed');

    // The escalation stays auditable, as constant ids only — never the matched words.
    const log = (await listLogs(app, callId)).find(
      (r) => r.stage === 'extract' && r.outcome === 'completed',
    );
    expect(log?.detail).toMatchObject({
      urgency: 'emergency',
      urgency_triggers: ['emergency_keyword'],
    });
    expect(JSON.stringify(log?.detail)).not.toContain('gas');
  });

  it('a MODEL-rated emergency (no keyword) also completes with no review row', async () => {
    const callId = 'test-emg-model';
    await seed(callId, 'Caller: the line is backing up and I need help today.');
    await runPipeline(
      app,
      callId,
      silent,
      set({ extract: vi.fn(() => Promise.resolve(result({ urgency: 'emergency' }))) }),
    );

    expect(await storedUrgency(callId)).toBe('emergency');
    expect(await countRows('review_queue', callId)).toBe(0);
    expect((await getCallState(app, callId))?.status).toBe('completed');
    const log = (await listLogs(app, callId)).find(
      (r) => r.stage === 'extract' && r.outcome === 'completed',
    );
    expect(log?.detail).toMatchObject({ urgency_triggers: ['model_urgency'] });
  });

  it('an AMBIGUOUS-tier call is upgraded one level and still completes', async () => {
    const callId = 'test-emg-ambiguous';
    await seed(callId, 'Caller: there is an active leak under the sink.');
    await runPipeline(
      app,
      callId,
      silent,
      set({ extract: vi.fn(() => Promise.resolve(result())) }),
    );

    expect(await storedUrgency(callId)).toBe('urgent');
    expect(await countRows('review_queue', callId)).toBe(0);
  });

  it('SCOPE GUARD: a schema-invalid record still holds — only the emergency hold was removed', async () => {
    const callId = 'test-emg-scope';
    await seed(callId, 'Caller: I smell a gas leak in the kitchen and need someone out.');
    // Out-of-vocabulary service_category: the .strict() schema gate rejects it. Same emergency
    // keyword as the first case, so this isolates the reason for the hold.
    await runPipeline(
      app,
      callId,
      silent,
      set({ extract: vi.fn(() => Promise.resolve(result({ service_category: 'time_machine' }))) }),
    );

    const r = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(r.rows.map((x) => x.held_reason)).toEqual(['schema_invalid']);
    expect((await getCallState(app, callId))?.status).toBe('held');
  });
});
