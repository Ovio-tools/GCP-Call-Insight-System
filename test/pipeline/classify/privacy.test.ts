import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ClassifyModelClient, ClassifyModelResult } from '../../../src/anthropic/client.js';
import { createClassifyHandler } from '../../../src/pipeline/classify/handler.js';
import { buildProductionStageHandlers } from '../../../src/pipeline/handlers.js';
import { runPipeline } from '../../../src/pipeline/state-machine.js';
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUserMessage,
} from '../../../src/pipeline/classify/prompt.js';
import type { Clock } from '../../../src/pipeline/fetch-transcript.js';
import type { DialpadClient } from '../../../src/dialpad/client/index.js';
import { DEK_BYTES, LocalKeyProvider } from '../../../src/crypto/index.js';
import { upsertCallState } from '../../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../../src/db/repositories/clean-transcripts-repo.js';
import { upsertDailyCost } from '../../../src/db/repositories/daily-cost-usage-repo.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { utcDay } from '../../../src/model/cost.js';
import { makeTestConfig } from '../../_config.js';
import { hasTestDb, makePool, migrate } from '../../db/_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from '../../db/_dal.js';

/**
 * Classify-stage privacy suite (Task 5.1, Task 8). Asserts the privacy boundary end-to-end for
 * the classify stage specifically: only the redacted text crosses to Anthropic, and neither
 * transcript content nor the model `reason` field reaches any log line, alert, review row, or
 * processing_log row. Complements the small privacy check in handler.test.ts; where that proves
 * the log-safety of a single happy path, this suite proves outbound-payload containment, the
 * NOWHERE-else property for raw PII, and the no-content-in-persisted-rows guarantee across the
 * spam/malformed/cost-cap/disabled routes.
 */

const PATTERN = 'test-clsp-%';

/** Fixed clock pinned to an unusual UTC day so daily_cost_usage rows never collide. */
const FIXED_NOW = new Date('1998-11-07T09:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock: Clock = { now: () => FIXED_NOW.getTime() };

/**
 * Planted markers. REDACTED_MARKER stands in for redacted transcript text that IS allowed to
 * cross to Anthropic but must never be logged/persisted. RAW_PII_MARKER stands in for raw PII
 * that is NOT in the redacted text and must appear NOWHERE — not even in the outbound payload.
 * REASON_MARKER is planted in the model's JSON `reason`, which the parser discards; it must
 * never reach a log line or a persisted row.
 */
const REDACTED_MARKER = '[REDACTED_MARKER_XYZ]';
const RAW_PII_MARKER = 'RAW_SSN_123456789';
const REASON_MARKER = 'REASON_MARKER_QRS';

/** A fake model result whose JSON `text` carries the planted REASON_MARKER in its reason. */
function resultWithReason(
  bucket: string,
  over: Partial<ClassifyModelResult> = {},
): ClassifyModelResult {
  return {
    text: `{"bucket":"${bucket}","reason":"${REASON_MARKER} internal note"}`,
    stopReason: 'end_turn',
    inputTokens: 1234,
    outputTokens: 56,
    usagePresent: true,
    ...over,
  };
}

/** A Dialpad client stub — classify never touches it, but buildProductionStageHandlers wants one. */
const dialpadStub: DialpadClient = {
  fetchTranscript: vi.fn(() => Promise.resolve({ kind: 'not_ready' as const })),
  listRecentlyConcludedCalls: vi.fn(() => Promise.resolve({ calls: [] })),
};

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

describe.skipIf(!hasTestDb)('classify stage privacy boundary', () => {
  let owner!: Pool;
  let app!: Pool;

  const seed = async (callId: string, redacted: string): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'classify',
      status: 'processing',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
  };

  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  /** Build the classify handler with the fixed clock; enabled unless overridden. */
  function handler(getModel: () => ClassifyModelClient, overrides = {}) {
    const config = makeTestConfig({ CLASSIFY_ENABLED: true, ...overrides });
    return createClassifyHandler({ getModel, config, clock });
  }

  /**
   * Build the FULL production handler set so `runPipeline` routes classify's `hold` through the
   * state machine's `holdCall` — which is what actually writes the `review_queue` and
   * `processing_log` rows. Asserting those rows against a directly-invoked handler would be
   * vacuous (the handler only returns a StageResult; the runner performs the writes).
   */
  function set(getModel: () => ClassifyModelClient, overrides = {}) {
    const config = makeTestConfig({ CLASSIFY_ENABLED: true, ...overrides });
    return buildProductionStageHandlers({
      client: dialpadStub,
      keyProvider,
      queue: { add: vi.fn(() => Promise.resolve()) },
      config,
      clock,
      getClassifyModel: getModel,
    });
  }

  /**
   * Serialize every column of every row for a call in `table` into one string. `alert_events`
   * has no `call_id` column — the sanitized call_id lives inside `failure_snapshot` — so it is
   * matched on that jsonb field instead.
   */
  const serializedRows = async (table: string, callId: string): Promise<string> => {
    const r =
      table === 'alert_events'
        ? await owner.query(`SELECT * FROM ${table} WHERE failure_snapshot->>'call_id' = $1`, [
            callId,
          ])
        : await owner.query(`SELECT * FROM ${table} WHERE call_id = $1`, [callId]);
    return JSON.stringify(r.rows);
  };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(
      `DELETE FROM alert_events WHERE error_code IN
        ('MODEL_COST_CAP_EXCEEDED','MODEL_MALFORMED_RESPONSE','MODEL_AUTH_FAILED',
         'MODEL_RATE_LIMITED','CONFIG_MISSING_OR_INVALID')`,
    );
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  // ---- outbound payload containment --------------------------------------------

  it('sends ONLY system + built user message; redacted text crosses, raw PII appears nowhere', async () => {
    const callId = 'test-clsp-payload';
    // The redacted_text carries the allowed redacted marker but NOT the raw PII marker.
    const redacted = `Caller: my unit is down. ${REDACTED_MARKER}`;
    await seed(callId, redacted);

    let captured: { system: string; userText: string } | undefined;
    const model: ClassifyModelClient = {
      classify: (req) => {
        captured = req;
        return Promise.resolve(resultWithReason('customer'));
      },
    };
    const silent = createRootLogger({ level: 'silent' });
    await handler(() => model)({ callId, stage: 'classify', logger: silent, pool: app });

    expect(captured).toBeDefined();
    const { system, userText } = captured!;

    // system is EXACTLY the fixed policy prompt — the transcript never enters the system role.
    expect(system).toBe(CLASSIFY_SYSTEM_PROMPT);
    expect(system).not.toContain(REDACTED_MARKER);

    // userText is EXACTLY the built user message — nothing else (no metadata, no call_id, no
    // extra framing beyond buildClassifyUserMessage).
    expect(userText).toBe(buildClassifyUserMessage(redacted));
    // The redacted marker DOES cross (redacted text is what we classify).
    expect(userText).toContain(REDACTED_MARKER);

    // Critically: the raw PII marker was never in the redacted text, so it must appear NOWHERE
    // in the entire outbound payload. Only redacted text crosses the boundary.
    expect(system + userText).not.toContain(RAW_PII_MARKER);
    // And call_id is not smuggled into the payload.
    expect(system + userText).not.toContain(callId);
  });

  // ---- no content in logs ------------------------------------------------------

  it('never logs transcript content or the model reason across customer/spam/malformed/cost-cap/disabled paths', async () => {
    const { lines, logger } = collectingLogger();
    const redacted = `Caller speaking. ${REDACTED_MARKER}`;

    // customer (routes to continue within the handler) — reason present in model output.
    const customerId = 'test-clsp-log-customer';
    await seed(customerId, redacted);
    await handler(() => ({ classify: () => Promise.resolve(resultWithReason('customer')) }))({
      callId: customerId,
      stage: 'classify',
      logger,
      pool: app,
    });

    // spam → held; reason present.
    const spamId = 'test-clsp-log-spam';
    await seed(spamId, redacted);
    await handler(() => ({ classify: () => Promise.resolve(resultWithReason('spam')) }))({
      callId: spamId,
      stage: 'classify',
      logger,
      pool: app,
    });

    // malformed (prose, not JSON) but reason-looking marker embedded in the text → held.
    const malformedId = 'test-clsp-log-malformed';
    await seed(malformedId, redacted);
    await handler(() => ({
      classify: () =>
        Promise.resolve(
          resultWithReason('customer', {
            text: `not json but ${REASON_MARKER} ${REDACTED_MARKER}`,
          }),
        ),
    }))({ callId: malformedId, stage: 'classify', logger, pool: app });

    // cost-cap → held before the model is called.
    const capId = 'test-clsp-log-costcap';
    await seed(capId, redacted);
    await upsertDailyCost(owner, {
      day: FIXED_DAY,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: makeTestConfig().DAILY_MODEL_COST_CAP_USD,
    });
    await handler(() => ({
      classify: () => {
        throw new Error('model must not be called at cap');
      },
    }))({ callId: capId, stage: 'classify', logger, pool: app });
    // Reset the day's cost row now (not just in afterEach) so the disabled-path run below, still
    // in this same test, doesn't itself trip the cost cap left behind by the cap check above.
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);

    // disabled → parked.
    const disabledId = 'test-clsp-log-disabled';
    await seed(disabledId, redacted);
    await handler(
      () => ({
        classify: () => {
          throw new Error('model must not be called when disabled');
        },
      }),
      { CLASSIFY_ENABLED: false },
    )({ callId: disabledId, stage: 'classify', logger, pool: app });

    // Positive guard: prove the handler actually logged across all five runs before asserting
    // absence of content — an empty-log no-op must FAIL this test, not vacuously pass it.
    expect(lines.length).toBeGreaterThan(0);

    const out = lines.join('');
    // No transcript content (the redacted marker) and no model reason anywhere in the logs.
    expect(out).not.toContain(REDACTED_MARKER);
    expect(out).not.toContain(REASON_MARKER);
    expect(out).not.toContain(RAW_PII_MARKER);
  });

  // ---- no content in persisted rows --------------------------------------------

  const rowCount = async (table: string, callId: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };

  it('spam hold: review_queue / processing_log carry no transcript or reason content', async () => {
    const callId = 'test-clsp-rows-spam';
    const redacted = `Robocall detected. ${REDACTED_MARKER}`;
    await seed(callId, redacted);
    const silent = createRootLogger({ level: 'silent' });
    // Drive the FULL pipeline so the runner's holdCall actually writes review_queue + processing_log.
    await runPipeline(
      app,
      callId,
      silent,
      set(() => ({ classify: () => Promise.resolve(resultWithReason('spam')) })),
    );

    // Positive guards: the runner must have written the rows we are about to scan — otherwise the
    // absence assertions below would pass vacuously against empty tables.
    const reviews = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]?.held_reason).toBe('classified_spam');
    expect(await rowCount('processing_log', callId)).toBeGreaterThan(0);
    // Spam is a routing outcome, not a failure — no alert is emitted for it.
    const spamAlerts = await serializedRows('alert_events', callId);
    expect(spamAlerts).toBe('[]');

    for (const table of ['review_queue', 'processing_log']) {
      const serialized = await serializedRows(table, callId);
      expect(serialized, `${table} must not contain the transcript marker`).not.toContain(
        REDACTED_MARKER,
      );
      expect(serialized, `${table} must not contain the model reason marker`).not.toContain(
        REASON_MARKER,
      );
      expect(serialized, `${table} must not contain raw PII`).not.toContain(RAW_PII_MARKER);
    }
  });

  it('malformed hold: review_queue / processing_log / alert_events carry no transcript or reason content', async () => {
    const callId = 'test-clsp-rows-malformed';
    const redacted = `Ambiguous fragment. ${REDACTED_MARKER}`;
    await seed(callId, redacted);
    const silent = createRootLogger({ level: 'silent' });
    // Malformed output whose text embeds BOTH the reason marker and the transcript marker — the
    // most adversarial case for row leakage (nothing downstream must persist either). Drive the
    // full pipeline so holdCall writes review_queue + processing_log.
    await runPipeline(
      app,
      callId,
      silent,
      set(() => ({
        classify: () =>
          Promise.resolve(
            resultWithReason('customer', {
              text: `prose ${REASON_MARKER} ${REDACTED_MARKER}`,
              stopReason: 'end_turn',
            }),
          ),
      })),
    );

    // Positive guards: every table we scan must have its expected row first.
    const reviews = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]?.held_reason).toBe('malformed_model_output');
    expect(await rowCount('processing_log', callId)).toBeGreaterThan(0);
    // The alert row exists (MODEL_MALFORMED_RESPONSE) and carries only sanitized metadata.
    const alerts = await owner.query(
      `SELECT * FROM alert_events WHERE failure_snapshot->>'call_id' = $1`,
      [callId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ error_code: 'MODEL_MALFORMED_RESPONSE' });

    for (const table of ['review_queue', 'processing_log', 'alert_events']) {
      const serialized = await serializedRows(table, callId);
      expect(serialized, `${table} must not contain the transcript marker`).not.toContain(
        REDACTED_MARKER,
      );
      expect(serialized, `${table} must not contain the model reason marker`).not.toContain(
        REASON_MARKER,
      );
      expect(serialized, `${table} must not contain raw PII`).not.toContain(RAW_PII_MARKER);
    }
  });
});
