import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { CONFIG_ERROR_CODE, ConfigError } from '../../../src/config/index.js';
import {
  type ExtractModelClient,
  type ModelTextResult,
  ModelApiError,
} from '../../../src/anthropic/client.js';
import { createExtractHandler } from '../../../src/pipeline/extract/handler.js';
import * as alertRepo from '../../../src/db/repositories/alert-events-repo.js';
import type { StageContext, StageResult } from '../../../src/pipeline/stages.js';
import type { Clock } from '../../../src/pipeline/fetch-transcript.js';
import { upsertCallState, getCallState } from '../../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../../src/db/repositories/clean-transcripts-repo.js';
import {
  appendLog,
  listByCall as listLogs,
} from '../../../src/db/repositories/processing-log-repo.js';
import { listByCall as listInvocations } from '../../../src/db/repositories/model-invocations-repo.js';
import { getExtractionCandidate } from '../../../src/db/repositories/extraction-candidates-repo.js';
import { upsertDailyCost, getDay } from '../../../src/db/repositories/daily-cost-usage-repo.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { utcDay } from '../../../src/model/cost.js';
import { makeTestConfig } from '../../_config.js';
import { hasTestDb, makePool, migrate } from '../../db/_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from '../../db/_dal.js';

const PATTERN = 'test-ext-%';

/** A fixed clock pinned to an unusual UTC day so daily_cost_usage rows never collide. */
const FIXED_NOW = new Date('1998-11-07T12:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock: Clock = { now: () => FIXED_NOW.getTime() };

/** A redacted transcript the golden phrases quote verbatim (light-normalized). */
const REDACTED =
  'Caller: my water heater is leaking and it stopped making hot water. I need someone to come out.';

/** A schema-valid, verbatim, PII-free extraction record (snake_case, matching the wire schema). */
const GOLDEN = {
  call_intent: 'new_booking',
  service_category: 'water_heater',
  problem_statement: 'water heater is leaking and no hot water',
  symptoms: ['leaking', 'no hot water'],
  concerns: [],
  customer_language: ['my water heater is leaking', 'it stopped making hot water'],
  competitor_mentions: [],
  location_in_home: null,
  access_or_scheduling_notes: null,
  prior_attempts: null,
  acquisition_source: null,
  urgency: 'routine',
  sentiment: 'neutral',
};

/** A canned extract result builder with sensible defaults (usage present, golden record). */
function result(over: Partial<ModelTextResult> = {}): ModelTextResult {
  return {
    text: JSON.stringify(GOLDEN),
    stopReason: 'end_turn',
    inputTokens: 2000,
    outputTokens: 300,
    usagePresent: true,
    ...over,
  };
}

/** A model spy returning a canned result (or throwing). Exposes the captured request. */
function fakeModel(impl: ExtractModelClient['extract']): {
  model: ExtractModelClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return { model: { extract: spy }, spy };
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

const EXPECTED_INPUT_RATE = makeTestConfig().EXTRACT_COST_USD_PER_MTOK_INPUT;
const EXPECTED_OUTPUT_RATE = makeTestConfig().EXTRACT_COST_USD_PER_MTOK_OUTPUT;

describe.skipIf(!hasTestDb)('extract stage handler', () => {
  let owner!: Pool;
  let app!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  /** Seed call_state@extract + clean_transcripts + the classify `completed` bucket marker. */
  const seed = async (
    callId: string,
    redacted = REDACTED,
    bucket: string | null = 'customer',
  ): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'extract',
      status: 'processing',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
    if (bucket !== null) {
      await appendLog(app, {
        callId,
        stage: 'classify',
        outcome: 'completed',
        detail: { bucket },
      });
    }
  };

  const ctx = (callId: string, logger = silent): StageContext => ({
    callId,
    stage: 'extract',
    logger,
    pool: app,
  });

  /** Build the extract handler with a fixed clock; extract enabled unless overridden. The
   * wrapper narrows the handler's `StageResult | void` to a `StageResult` (extract never
   * returns void) so tests can read `.action` directly. */
  function handler(
    getModel: () => ExtractModelClient,
    overrides = {},
  ): (c: StageContext) => Promise<StageResult> {
    const config = makeTestConfig({ EXTRACT_ENABLED: true, ...overrides });
    const h = createExtractHandler({ getModel, config, clock });
    return async (c: StageContext): Promise<StageResult> => {
      const res = await h(c);
      if (!res) throw new Error('extract handler returned void — expected a StageResult');
      return res;
    };
  }

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

  const dayCost = async (): Promise<number> => {
    const row = await getDay(owner, FIXED_DAY);
    return row ? Number(row.estimated_cost) : 0;
  };

  const settledCost = (inputTokens: number, outputTokens: number): number =>
    (inputTokens * EXPECTED_INPUT_RATE + outputTokens * EXPECTED_OUTPUT_RATE) / 1_000_000;

  const reservedCost = (): number => {
    const cfg = makeTestConfig();
    return settledCost(cfg.EXTRACT_INPUT_TOKENS_CEILING, cfg.EXTRACT_MAX_TOKENS);
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner, 1);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(
      `DELETE FROM alert_events WHERE error_code IN
        ('MODEL_COST_CAP_EXCEEDED','MODEL_MALFORMED_RESPONSE','MODEL_AUTH_FAILED',
         'MODEL_RATE_LIMITED','CONFIG_MISSING_OR_INVALID','VERBATIM_PII_DETECTED')`,
    );
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  // ---- kill switch -------------------------------------------------------------

  it('kill switch → defer, model never built, one deferred park row across two runs, stays processing@extract', async () => {
    const callId = 'test-ext-killswitch';
    await seed(callId);
    const getModel = (): ExtractModelClient => {
      throw new Error('getModel must not be called when EXTRACT_ENABLED is false');
    };
    const h = handler(getModel, { EXTRACT_ENABLED: false });

    expect(await h(ctx(callId))).toEqual({ action: 'defer' });
    expect(await h(ctx(callId))).toEqual({ action: 'defer' });

    const parked = (await listLogs(app, callId)).filter(
      (r) => r.stage === 'extract' && r.outcome === 'deferred',
    );
    expect(parked).toHaveLength(1);
    expect(parked[0]?.detail).toEqual({ reason: 'extract_disabled' });

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('processing');
    expect(state?.current_stage).toBe('extract');
    expect(await countRows('model_invocations', callId)).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- classification guard ----------------------------------------------------

  it.each([
    ['missing marker', null],
    ['non-customer marker', 'non-customer'],
    ['spam marker', 'spam'],
  ] as const)('classification guard (%s) → throws, model never called', async (_name, bucket) => {
    const callId = `test-ext-guard-${_name.replace(/[^a-z]/g, '')}`;
    await seed(callId, REDACTED, bucket);
    const { spy } = fakeModel(() => Promise.resolve(result()));
    const h = handler(() => {
      throw new Error('getModel must not be called when the classification guard fails');
    });

    await expect(h(ctx(callId))).rejects.toBeInstanceOf(Error);
    expect(spy).not.toHaveBeenCalled();
    expect(await countRows('model_invocations', callId)).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- cost cap ----------------------------------------------------------------

  it('cost cap reached → held cost_cap_held + alert, model never called, nothing persisted', async () => {
    const callId = 'test-ext-costcap';
    await seed(callId);
    await upsertDailyCost(owner, {
      day: FIXED_DAY,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: makeTestConfig().DAILY_MODEL_COST_CAP_USD,
    });
    const { spy } = fakeModel(() => Promise.resolve(result()));
    const h = handler(() => {
      throw new Error('getModel must not be called when the cost cap is reached');
    });

    const res = await h(ctx(callId));
    expect(res).toEqual({
      action: 'hold',
      reason: 'cost_cap_held',
      errorCode: 'MODEL_COST_CAP_EXCEEDED',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(await alertCount('MODEL_COST_CAP_EXCEEDED')).toBe(1);
    expect(await countRows('model_invocations', callId)).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- billing dispositions ----------------------------------------------------

  it('auth error → throws, MODEL_AUTH_FAILED alert, reservation released, no invocation', async () => {
    const callId = 'test-ext-auth';
    await seed(callId);
    const { model } = fakeModel(() => Promise.reject(new ModelApiError('auth', 'not_billed', 401)));
    await expect(handler(() => model)(ctx(callId))).rejects.toBeInstanceOf(ModelApiError);

    expect(await alertCount('MODEL_AUTH_FAILED')).toBe(1);
    expect(await dayCost()).toBe(0);
    expect(await countRows('model_invocations', callId)).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  it('rate limit (429, not_billed) → throws, MODEL_RATE_LIMITED alert, released', async () => {
    const callId = 'test-ext-rate';
    await seed(callId);
    const { model } = fakeModel(() =>
      Promise.reject(new ModelApiError('rate_limited', 'not_billed', 429)),
    );
    await expect(handler(() => model)(ctx(callId))).rejects.toBeInstanceOf(ModelApiError);

    expect(await alertCount('MODEL_RATE_LIMITED')).toBe(1);
    expect(await dayCost()).toBe(0);
  });

  it('transient (maybe_billed) → throws, no stage alert, reservation KEPT', async () => {
    const callId = 'test-ext-transient';
    await seed(callId);
    const { model } = fakeModel(() =>
      Promise.reject(new ModelApiError('transient', 'maybe_billed')),
    );
    await expect(handler(() => model)(ctx(callId))).rejects.toBeInstanceOf(ModelApiError);

    expect(await alertCount('MODEL_AUTH_FAILED')).toBe(0);
    expect(await alertCount('MODEL_RATE_LIMITED')).toBe(0);
    expect(await dayCost()).toBeCloseTo(reservedCost(), 10);
  });

  it('getModel throws missing-key ConfigError → rethrows, released, CONFIG_MISSING_OR_INVALID alert with variable', async () => {
    const callId = 'test-ext-configerr';
    await seed(callId);
    const getModel = (): ExtractModelClient => {
      throw new ConfigError(
        ['ANTHROPIC_API_KEY'],
        `${CONFIG_ERROR_CODE}: ANTHROPIC_API_KEY is required to call the Anthropic API`,
      );
    };
    await expect(handler(getModel)(ctx(callId))).rejects.toBeInstanceOf(Error);

    expect(await dayCost()).toBe(0);
    expect(await alertCount('CONFIG_MISSING_OR_INVALID')).toBe(1);
    const snap = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
      `SELECT failure_snapshot FROM alert_events WHERE error_code = 'CONFIG_MISSING_OR_INVALID'`,
    );
    expect(snap.rows[0]?.failure_snapshot.variable).toBe('ANTHROPIC_API_KEY');
    expect(await countRows('model_invocations', callId)).toBe(0);
  });

  // ---- malformed ---------------------------------------------------------------

  it('bad JSON → held schema_invalid, MODEL_MALFORMED_RESPONSE alert, invocation malformed_response, spend settled', async () => {
    const callId = 'test-ext-malformed';
    await seed(callId);
    const { model } = fakeModel(() => Promise.resolve(result({ text: 'this is not json' })));
    const res = await handler(() => model)(ctx(callId));
    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('schema_invalid');
      expect(res.errorCode).toBe('MODEL_MALFORMED_RESPONSE');
      expect(res.detail).toMatchObject({ parse_failure: 'non_json' });
    }
    expect(await alertCount('MODEL_MALFORMED_RESPONSE')).toBe(1);
    const invocations = await listInvocations(app, callId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.outcome).toBe('malformed_response');
    expect(await countRows('extraction_candidates', callId)).toBe(0);
    expect(await dayCost()).toBeCloseTo(settledCost(2000, 300), 10);
  });

  it('usage missing (valid record) → held schema_invalid, reservation KEPT, invocation malformed_response', async () => {
    const callId = 'test-ext-usagemissing';
    await seed(callId);
    const { model } = fakeModel(() =>
      Promise.resolve(result({ usagePresent: false, inputTokens: 0, outputTokens: 0 })),
    );
    const res = await handler(() => model)(ctx(callId));
    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('schema_invalid');
      expect(res.detail).toMatchObject({ usage_missing: true });
    }
    const invocations = await listInvocations(app, callId);
    expect(invocations[0]?.outcome).toBe('malformed_response');
    expect(invocations[0]?.input_tokens).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
    // Usage-missing KEEPS the reservation (never undercount).
    expect(await dayCost()).toBeCloseTo(reservedCost(), 10);
  });

  it('uncontrolled service_category → held schema_invalid (fails zod parse), no candidate', async () => {
    const callId = 'test-ext-badcategory';
    await seed(callId);
    const bad = { ...GOLDEN, service_category: 'hvac' };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(bad) })));
    const res = await handler(() => model)(ctx(callId));
    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('schema_invalid');
      expect(res.detail).toMatchObject({ parse_failure: 'schema_invalid' });
    }
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- verbatim gate -----------------------------------------------------------

  it('verbatim mismatch (phrase not in transcript, no PII) → held schema_invalid, no candidate', async () => {
    const callId = 'test-ext-verbatim';
    await seed(callId);
    const fabricated = { ...GOLDEN, customer_language: ['the sink is completely blocked up'] };
    const { model } = fakeModel(() =>
      Promise.resolve(result({ text: JSON.stringify(fabricated) })),
    );
    const res = await handler(() => model)(ctx(callId));
    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('schema_invalid');
      expect(res.errorCode).toBe('MODEL_MALFORMED_RESPONSE');
      expect(res.detail).toMatchObject({ gate: 'verbatim_mismatch', mismatch_count: 1 });
    }
    expect(await alertCount('MODEL_MALFORMED_RESPONSE')).toBe(1);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- residual PII gate (precedence + resilience) -----------------------------

  it('planted PII in a phrase → held residual_pii_detected + VERBATIM_PII_DETECTED alert, counts-only, no candidate', async () => {
    const callId = 'test-ext-pii';
    const { lines, logger } = collectingLogger();
    await seed(callId);
    const planted = { ...GOLDEN, customer_language: ['please call 5551234567 today'] };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(planted) })));
    const res = await handler(() => model)(ctx(callId, logger));

    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('residual_pii_detected');
      expect(res.errorCode).toBe('VERBATIM_PII_DETECTED');
      expect(res.detail).toMatchObject({ residual_categories: ['digit_run'] });
    }
    expect(await alertCount('VERBATIM_PII_DETECTED')).toBe(1);
    expect(await countRows('extraction_candidates', callId)).toBe(0);

    // Privacy: the planted digits never reach the alert snapshot or the logs.
    const snap = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
      `SELECT failure_snapshot FROM alert_events WHERE error_code = 'VERBATIM_PII_DETECTED'`,
    );
    const snapStr = JSON.stringify(snap.rows[0]?.failure_snapshot);
    expect(snapStr).not.toContain('5551234567');
    expect(snapStr).toContain('digit_run');
    expect(lines.join('')).not.toContain('5551234567');
  });

  it('planted-PII alert insert throws → still returns residual_pii_detected hold (resilient side effect)', async () => {
    const callId = 'test-ext-pii-resilient';
    await seed(callId);
    const planted = { ...GOLDEN, customer_language: ['please call 5551234567 today'] };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(planted) })));
    const spy = vi
      .spyOn(alertRepo, 'recordAlert')
      .mockRejectedValueOnce(new Error('simulated alert_events insert failure'));
    try {
      const res = await handler(() => model)(ctx(callId));
      expect(res.action).toBe('hold');
      if (res.action === 'hold') expect(res.reason).toBe('residual_pii_detected');
      expect(await countRows('extraction_candidates', callId)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('fabricated phrase that ALSO contains planted PII → held residual_pii_detected (PII precedence over verbatim)', async () => {
    const callId = 'test-ext-pii-precedence';
    await seed(callId);
    // Not verbatim in the transcript AND carries a digit run: PII gate (step 11) must win.
    const both = { ...GOLDEN, customer_language: ['a made-up phrase with 5551234567 inside'] };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(both) })));
    const res = await handler(() => model)(ctx(callId));
    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('residual_pii_detected');
      expect(res.errorCode).toBe('VERBATIM_PII_DETECTED');
    }
    expect(await alertCount('MODEL_MALFORMED_RESPONSE')).toBe(0);
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });

  // ---- token gate --------------------------------------------------------------

  it('tokened phrase dropped, clean phrases persisted, tokened_phrases_dropped in continue detail', async () => {
    const callId = 'test-ext-tokened';
    const redacted =
      'Caller: my water heater is leaking. [NAME_1] said it stopped making hot water.';
    await seed(callId, redacted);
    const rec = {
      ...GOLDEN,
      customer_language: [
        'my water heater is leaking',
        '[NAME_1] said it stopped making hot water',
      ],
    };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
    const res = await handler(() => model)(ctx(callId));

    expect(res.action).toBe('continue');
    if (res.action === 'continue') {
      expect(res.detail).toMatchObject({ tokened_phrases_dropped: 1, phrase_count: 1 });
    }
    const cand = await getExtractionCandidate(app, callId);
    expect(cand?.customer_language).toEqual(['my water heater is leaking']);
  });

  // ---- emergency ---------------------------------------------------------------

  it('emergency keyword → held emergency_review, candidate persisted with urgency=emergency, no errorCode', async () => {
    const callId = 'test-ext-emergency';
    const redacted = 'Caller: I smell a gas leak in the kitchen and need help now.';
    await seed(callId, redacted);
    const rec = {
      ...GOLDEN,
      service_category: 'gas_line',
      problem_statement: 'possible gas leak',
      symptoms: [],
      customer_language: ['i smell a gas leak in the kitchen'],
      urgency: 'routine',
    };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
    const res = await handler(() => model)(ctx(callId));

    expect(res.action).toBe('hold');
    if (res.action === 'hold') {
      expect(res.reason).toBe('emergency_review');
      expect(res.errorCode).toBeUndefined();
      expect(res.detail).toMatchObject({ urgency: 'emergency' });
    }
    const cand = await getExtractionCandidate(app, callId);
    expect(cand?.urgency).toBe('emergency');
    // Routing outcome, not a failure — no alert.
    expect(await alertCount('MODEL_MALFORMED_RESPONSE')).toBe(0);
  });

  // ---- golden happy path + idempotency -----------------------------------------

  it('golden → continue, candidate matches, invocation success, spend settled', async () => {
    const callId = 'test-ext-golden';
    await seed(callId);
    const { model, spy } = fakeModel(() => Promise.resolve(result()));
    const res = await handler(() => model)(ctx(callId));

    expect(res.action).toBe('continue');
    if (res.action === 'continue') {
      expect(res.detail).toMatchObject({
        phrase_count: 2,
        tokened_phrases_dropped: 0,
        urgency: 'routine',
      });
    }

    // Only the two fixed strings crossed to the model; system prompt unchanged.
    const req = spy.mock.calls[0]?.[0] as { system: string; userText: string };
    expect(req.userText).toContain(REDACTED);

    const cand = await getExtractionCandidate(app, callId);
    expect(cand).toMatchObject({
      call_intent: 'new_booking',
      service_category: 'water_heater',
      customer_language: GOLDEN.customer_language,
      urgency: 'routine',
      sentiment: 'neutral',
      schema_version: 1,
      prompt_version: 'extract-v1',
      model_id: makeTestConfig().EXTRACT_MODEL_ID,
      pii_scan_status: 'pending',
    });

    const invocations = await listInvocations(app, callId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      stage: 'extract',
      model_id: makeTestConfig().EXTRACT_MODEL_ID,
      prompt_version: 'extract-v1',
      outcome: 'success',
      input_tokens: 2000,
      output_tokens: 300,
    });
    expect(await dayCost()).toBeCloseTo(settledCost(2000, 300), 10);
  });

  it('golden twice → exactly one candidate row, pii_scan_status reset to pending', async () => {
    const callId = 'test-ext-idempotent';
    await seed(callId);
    const { model } = fakeModel(() => Promise.resolve(result()));
    await handler(() => model)(ctx(callId));
    await handler(() => model)(ctx(callId));

    expect(await countRows('extraction_candidates', callId)).toBe(1);
    const cand = await getExtractionCandidate(app, callId);
    expect(cand?.pii_scan_status).toBe('pending');
  });
});
