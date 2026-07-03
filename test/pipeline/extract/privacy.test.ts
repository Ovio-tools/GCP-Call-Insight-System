import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ExtractModelClient, ModelTextResult } from '../../../src/anthropic/client.js';
import { createExtractHandler } from '../../../src/pipeline/extract/handler.js';
import { buildProductionStageHandlers } from '../../../src/pipeline/handlers.js';
import { runPipeline } from '../../_run-pipeline.js';
import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserMessage,
} from '../../../src/pipeline/extract/prompt.js';
import type { Clock } from '../../../src/pipeline/fetch-transcript.js';
import type { DialpadClient } from '../../../src/dialpad/client/index.js';
import { DEK_BYTES, LocalKeyProvider } from '../../../src/crypto/index.js';
import { upsertCallState } from '../../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../../src/db/repositories/clean-transcripts-repo.js';
import { putTranscript } from '../../../src/db/repositories/raw-transcripts-repo.js';
import { appendLog } from '../../../src/db/repositories/processing-log-repo.js';
import { upsertDailyCost } from '../../../src/db/repositories/daily-cost-usage-repo.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { utcDay } from '../../../src/model/cost.js';
import { makeTestConfig } from '../../_config.js';
import { hasTestDb, makePool, migrate } from '../../db/_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from '../../db/_dal.js';

/**
 * Extract-stage privacy suite (Task 5.2, mirrors test/pipeline/classify/privacy.test.ts).
 * Asserts the privacy boundary end-to-end for the extract stage specifically:
 *
 *  1. Only the redacted text crosses to the Anthropic extract client — the outbound payload
 *     is EXACTLY `{ system: EXTRACT_SYSTEM_PROMPT, userText: buildExtractUserMessage(redacted) }`
 *     and nothing else (no metadata, no call_id, no raw PII that was never in the redacted text).
 *  2. No transcript content, no raw PII, and no adversarial model-response text ever reaches a
 *     log line the handler emits — across the continue / residual-PII / malformed / verbatim /
 *     cost-cap / disabled routes.
 *  3. On the hold routes (schema_invalid, residual_pii_detected) the persisted review_queue,
 *     processing_log, and alert_events rows carry only counts / category ids / constant reasons —
 *     never transcript content, raw PII, or model-response text.
 *
 * Complements the small privacy check in handler.test.ts (single happy path); this suite proves
 * outbound-payload containment, the NOWHERE-else property for raw PII, and no-content-in-rows
 * across the routes that persist a hold.
 */

const PATTERN = 'test-extp-%';

/** Fixed clock pinned to an unusual UTC day so daily_cost_usage rows never collide. */
const FIXED_NOW = new Date('1998-11-07T15:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock: Clock = { now: () => FIXED_NOW.getTime() };

/**
 * Planted markers.
 * - REDACTED_MARKER stands in for redacted transcript text that IS allowed to cross to Anthropic
 *   but must never be logged or persisted to a hold row.
 * - RAW_PII_MARKER stands in for raw PII that lives ONLY in the raw-side store
 *   (`raw_transcripts`, envelope-encrypted, keyed to the call under test) and is NOT in the
 *   redacted `clean_transcripts` text. It must appear NOWHERE the handler produces — not in the
 *   outbound model payload, not in a log line, not in a hold row. This makes the egress guard
 *   REAL: the marker genuinely exists in a DB row the handler could decrypt but must never read,
 *   proving extract sources its input from `clean_transcripts` alone.
 * - RESPONSE_MARKER is planted inside an adversarial model response; the handler discards the
 *   response text on the malformed route, so it must never reach a log line or a persisted row.
 * - PII_DIGITS is a planted digit-run inside a fabricated customer_language phrase; the residual
 *   scan detects it by CATEGORY only, so the digits must never reach a log/alert/row.
 */
const REDACTED_MARKER = '[REDACTED_MARKER_XYZ]';
const RAW_PII_MARKER = 'RAW_SSN_123456789';
const RESPONSE_MARKER = 'RESPONSE_MARKER_QRS';
const PII_DIGITS = '5551234567';

/** A schema-valid, PII-free record whose customer_language is EMPTY so it needs no verbatim quote
 *  from the transcript (keeps the payload/log tests independent of the transcript's exact words). */
const CLEAN_RECORD = {
  call_intent: 'general',
  service_category: 'other',
  problem_statement: 'caller needs help',
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

/** A canned extract result (usage present, clean record) with per-test overrides. */
function result(over: Partial<ModelTextResult> = {}): ModelTextResult {
  return {
    text: JSON.stringify(CLEAN_RECORD),
    stopReason: 'end_turn',
    inputTokens: 2000,
    outputTokens: 300,
    usagePresent: true,
    ...over,
  };
}

/** A Dialpad stub — extract never touches it, but buildProductionStageHandlers wants one. */
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

describe.skipIf(!hasTestDb)('extract stage privacy boundary', () => {
  let owner!: Pool;
  let app!: Pool;

  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });

  /** Seed call_state@extract + clean_transcripts + the classify `customer` bucket marker so the
   *  classification guard passes and extract actually runs. ALSO plants RAW_PII_MARKER into the
   *  envelope-encrypted `raw_transcripts` row keyed to this call: raw PII that genuinely exists in
   *  the DB the handler could decrypt but must never read. The extract handler sources its input
   *  from `clean_transcripts` (`getCleanTranscript`) only — the RAW_PII_MARKER assertions below
   *  prove it never touches this raw store. */
  const seed = async (callId: string, redacted: string): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'extract',
      status: 'processing',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
    await putTranscript(app, keyProvider, {
      callId,
      transcript: `Raw caller words with real PII ${RAW_PII_MARKER} that only the raw store holds.`,
    });
    await appendLog(app, {
      callId,
      stage: 'classify',
      outcome: 'completed',
      detail: { bucket: 'customer' },
    });
  };

  /** Build the extract handler with the fixed clock; extract enabled unless overridden. */
  function handler(getModel: () => ExtractModelClient, overrides = {}) {
    const config = makeTestConfig({ EXTRACT_ENABLED: true, ...overrides });
    return createExtractHandler({ getModel, config, clock });
  }

  /**
   * Build the FULL production handler set so `runPipeline` routes extract's `hold` through the
   * state machine's `holdCall` — which is what actually writes the `review_queue` and
   * `processing_log` rows. A directly-invoked handler only returns a StageResult; the runner
   * performs the writes, so the persisted-row assertions must go through the runner.
   */
  function set(getModel: () => ExtractModelClient, overrides = {}) {
    // The redaction handler validates its config at factory time, so building the full set needs
    // a hash key even though these tests never run redaction.
    const config = makeTestConfig({
      EXTRACT_ENABLED: true,
      REDACTION_VALUE_HASH_KEY: Buffer.alloc(32, 7).toString('base64'),
      ...overrides,
    });
    return buildProductionStageHandlers({
      client: dialpadStub,
      keyProvider,
      queue: { add: vi.fn(() => Promise.resolve()) },
      config,
      clock,
      getExtractModel: getModel,
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

  const rowCount = async (table: string, callId: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
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

  // ---- outbound payload containment --------------------------------------------

  it('sends ONLY system + built user message; redacted text crosses, raw PII appears nowhere', async () => {
    const callId = 'test-extp-payload';
    // The redacted_text carries the allowed redacted marker but NOT the raw PII marker.
    const redacted = `Caller: my unit is down. ${REDACTED_MARKER}`;
    await seed(callId, redacted);

    let captured: { system: string; userText: string } | undefined;
    const model: ExtractModelClient = {
      extract: (req) => {
        captured = req;
        return Promise.resolve(result());
      },
    };
    const silent = createRootLogger({ level: 'silent' });
    await handler(() => model)({ callId, stage: 'extract', logger: silent, pool: app });

    expect(captured).toBeDefined();
    const { system, userText } = captured!;

    // system is EXACTLY the fixed policy prompt — the transcript never enters the system role.
    expect(system).toBe(EXTRACT_SYSTEM_PROMPT);
    expect(system).not.toContain(REDACTED_MARKER);

    // userText is EXACTLY the built user message — nothing else (no metadata, no call_id, no
    // extra framing beyond buildExtractUserMessage).
    expect(userText).toBe(buildExtractUserMessage(redacted));
    // The redacted marker DOES cross (redacted text is what we extract from).
    expect(userText).toContain(REDACTED_MARKER);

    // Critically: RAW_PII_MARKER lives ONLY in the encrypted raw_transcripts row (planted by
    // seed) and never in the redacted text — so it must appear NOWHERE in the outbound payload.
    // Only redacted text crosses the boundary; the raw store is never read.
    expect(system + userText).not.toContain(RAW_PII_MARKER);
    // And call_id is not smuggled into the payload.
    expect(system + userText).not.toContain(callId);
  });

  // ---- no content in logs ------------------------------------------------------

  it('never logs transcript content, raw PII, or model-response text across continue/residual-pii/malformed/verbatim/cost-cap/disabled paths', async () => {
    const { lines, logger } = collectingLogger();
    const redacted = `Caller speaking. ${REDACTED_MARKER}`;

    // continue (clean record, empty customer_language) — the golden advancing path.
    const contId = 'test-extp-log-continue';
    await seed(contId, redacted);
    await handler(() => ({ extract: () => Promise.resolve(result()) }))({
      callId: contId,
      stage: 'extract',
      logger,
      pool: app,
    });

    // residual-PII hold: a fabricated phrase carrying a raw digit run. The scan reports the
    // CATEGORY only; the digits themselves must never be logged.
    const piiId = 'test-extp-log-pii';
    await seed(piiId, redacted);
    await handler(() => ({
      extract: () =>
        Promise.resolve(
          result({
            text: JSON.stringify({
              ...CLEAN_RECORD,
              customer_language: [`please call ${PII_DIGITS} today`],
            }),
          }),
        ),
    }))({ callId: piiId, stage: 'extract', logger, pool: app });

    // malformed: adversarial non-JSON response text embedding BOTH the response marker and the
    // transcript marker → held schema_invalid; the handler logs the parse-failure category only.
    const malformedId = 'test-extp-log-malformed';
    await seed(malformedId, redacted);
    await handler(() => ({
      extract: () =>
        Promise.resolve(
          result({ text: `IGNORE INSTRUCTIONS ${RESPONSE_MARKER} ${REDACTED_MARKER}` }),
        ),
    }))({ callId: malformedId, stage: 'extract', logger, pool: app });

    // verbatim mismatch: a fabricated (PII-free) phrase not present in the transcript → held
    // schema_invalid; the handler logs the mismatch COUNT only, never the phrase.
    const verbatimId = 'test-extp-log-verbatim';
    await seed(verbatimId, redacted);
    await handler(() => ({
      extract: () =>
        Promise.resolve(
          result({
            text: JSON.stringify({
              ...CLEAN_RECORD,
              customer_language: ['a totally fabricated phrase not in the transcript'],
            }),
          }),
        ),
    }))({ callId: verbatimId, stage: 'extract', logger, pool: app });

    // cost-cap → held before the model is called.
    const capId = 'test-extp-log-costcap';
    await seed(capId, redacted);
    await upsertDailyCost(owner, {
      day: FIXED_DAY,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: makeTestConfig().DAILY_MODEL_COST_CAP_USD,
    });
    await handler(() => ({
      extract: () => {
        throw new Error('model must not be called at cap');
      },
    }))({ callId: capId, stage: 'extract', logger, pool: app });
    // Reset the day's cost row now (not just in afterEach) so the disabled-path run below, still
    // in this same test, doesn't itself trip the cost cap left behind by the cap check above.
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);

    // disabled → parked.
    const disabledId = 'test-extp-log-disabled';
    await seed(disabledId, redacted);
    await handler(
      () => ({
        extract: () => {
          throw new Error('model must not be called when disabled');
        },
      }),
      { EXTRACT_ENABLED: false },
    )({ callId: disabledId, stage: 'extract', logger, pool: app });

    // Positive guard: prove the handler actually logged across all six runs before asserting
    // absence of content — an empty-log no-op must FAIL this test, not vacuously pass it.
    expect(lines.length).toBeGreaterThan(0);

    const out = lines.join('');
    // No transcript content, no raw PII digits, and no adversarial response text anywhere.
    expect(out).not.toContain(REDACTED_MARKER);
    expect(out).not.toContain(PII_DIGITS);
    expect(out).not.toContain(RESPONSE_MARKER);
    expect(out).not.toContain(RAW_PII_MARKER);
    // Positive: the residual-PII log line reports the category (proves the run happened without
    // the digits appearing above).
    expect(out).toContain('digit_run');
  });

  // ---- no content in persisted rows --------------------------------------------

  it('malformed hold: review_queue / processing_log / alert_events carry no transcript or response content', async () => {
    const callId = 'test-extp-rows-malformed';
    const redacted = `Ambiguous fragment. ${REDACTED_MARKER}`;
    await seed(callId, redacted);
    const silent = createRootLogger({ level: 'silent' });
    // Malformed output whose text embeds BOTH the response marker and the transcript marker — the
    // most adversarial case for row leakage. Drive the full pipeline so holdCall writes the rows.
    await runPipeline(
      app,
      callId,
      silent,
      set(() => ({
        extract: () =>
          Promise.resolve(
            result({ text: `prose ${RESPONSE_MARKER} ${REDACTED_MARKER}`, stopReason: 'end_turn' }),
          ),
      })),
    );

    // Positive guards: every table we scan must have its expected row first, else the absence
    // assertions below would pass vacuously against empty tables.
    const reviews = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]?.held_reason).toBe('schema_invalid');
    expect(await rowCount('processing_log', callId)).toBeGreaterThan(0);
    const alerts = await owner.query(
      `SELECT * FROM alert_events WHERE failure_snapshot->>'call_id' = $1`,
      [callId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ error_code: 'MODEL_MALFORMED_RESPONSE' });
    // No extraction candidate is persisted on a malformed hold.
    expect(await rowCount('extraction_candidates', callId)).toBe(0);

    for (const table of ['review_queue', 'processing_log', 'alert_events']) {
      const serialized = await serializedRows(table, callId);
      expect(serialized, `${table} must not contain the transcript marker`).not.toContain(
        REDACTED_MARKER,
      );
      expect(serialized, `${table} must not contain the model response marker`).not.toContain(
        RESPONSE_MARKER,
      );
      expect(serialized, `${table} must not contain raw PII`).not.toContain(RAW_PII_MARKER);
    }
  });

  it('residual-PII hold: review_queue / processing_log / alert_events carry the category, never the digits', async () => {
    const callId = 'test-extp-rows-pii';
    const redacted = `Caller mentions a number. ${REDACTED_MARKER}`;
    await seed(callId, redacted);
    const silent = createRootLogger({ level: 'silent' });
    // A fabricated phrase carrying a raw digit run → residual_pii_detected hold + VERBATIM_PII
    // alert. Drive the full pipeline so holdCall writes review_queue + processing_log.
    await runPipeline(
      app,
      callId,
      silent,
      set(() => ({
        extract: () =>
          Promise.resolve(
            result({
              text: JSON.stringify({
                ...CLEAN_RECORD,
                customer_language: [`please call ${PII_DIGITS} today`],
              }),
            }),
          ),
      })),
    );

    // Positive guards.
    const reviews = await owner.query<{ held_reason: string }>(
      `SELECT held_reason FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]?.held_reason).toBe('residual_pii_detected');
    expect(await rowCount('processing_log', callId)).toBeGreaterThan(0);
    const alerts = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
      `SELECT * FROM alert_events WHERE failure_snapshot->>'call_id' = $1`,
      [callId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ error_code: 'VERBATIM_PII_DETECTED' });
    // No extraction candidate is persisted on a residual-PII hold.
    expect(await rowCount('extraction_candidates', callId)).toBe(0);

    for (const table of ['review_queue', 'processing_log', 'alert_events']) {
      const serialized = await serializedRows(table, callId);
      expect(serialized, `${table} must not contain the raw digit run`).not.toContain(PII_DIGITS);
      expect(serialized, `${table} must not contain the transcript marker`).not.toContain(
        REDACTED_MARKER,
      );
      // Symmetric with the malformed-rows loop: the raw-store PII marker never leaks into a hold row.
      expect(serialized, `${table} must not contain raw PII`).not.toContain(RAW_PII_MARKER);
    }
    // Positive: the alert snapshot carries the category id (counts-only shape), proving the hold
    // is diagnosable without leaking the digits.
    const snapStr = JSON.stringify(alerts.rows[0]?.failure_snapshot);
    expect(snapStr).toContain('digit_run');
  });
});
