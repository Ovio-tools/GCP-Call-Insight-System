import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ExtractModelClient, ModelTextResult } from '../../../src/anthropic/client.js';
import { EXTRACT_OUTPUT_FORMAT } from '../../../src/anthropic/client.js';
import {
  extractionRecordSchema,
  parseExtraction,
  type ExtractionRecord,
} from '../../../src/pipeline/extract/parse.js';
import { createExtractHandler } from '../../../src/pipeline/extract/handler.js';
import { SERVICE_CATEGORIES, SENTIMENTS } from '../../../src/db/enums.js';
import {
  extractionCandidateInsertSchema,
  extractionCandidateRowSchema,
} from '../../../src/db/schemas/extraction-candidates.js';
import type { StageContext, StageResult } from '../../../src/pipeline/stages.js';
import type { Clock } from '../../../src/pipeline/fetch-transcript.js';
import { upsertCallState } from '../../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../../src/db/repositories/clean-transcripts-repo.js';
import { appendLog } from '../../../src/db/repositories/processing-log-repo.js';
import { getExtractionCandidate } from '../../../src/db/repositories/extraction-candidates-repo.js';
import { createRootLogger } from '../../../src/logging/logger.js';
import { utcDay } from '../../../src/model/cost.js';
import { makeTestConfig } from '../../_config.js';
import { hasTestDb, makePool, migrate } from '../../db/_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from '../../db/_dal.js';

/**
 * Extract-stage INVARIANT suite (Task 5.2, M7.3). Collects and hardens the load-bearing
 * properties the extract stage must uphold for ANY model output, independent of the
 * happy-path cases in handler.test.ts. Grounded in the real parse/gate/persist code:
 *
 *  1. `service_category` is ALWAYS from the controlled vocabulary — every controlled
 *     value is accepted and stored faithfully; every out-of-vocabulary value is REJECTED
 *     by the `.strict()` schema-validation gate (held `schema_invalid`), never stored.
 *  2. `sentiment` is INTERNAL ONLY — persisted to the `extraction_candidates` staging row
 *     and NOWHERE the stage exposes onward: not in the outbound model payload, not in the
 *     StageResult, not in a log line. (There is no KB/public egress surface at this stage;
 *     that is a later task. The strongest true invariant here is internal-store-only +
 *     absence from every pipeline-visible artifact the stage emits.)
 *  3. NO confidence/probability score is ever WRITTEN — the `.strict()` extraction schema
 *     REJECTS (does not strip) any extra key, so a smuggled `confidence` field holds the
 *     whole record `schema_invalid`; and no confidence field exists in the persisted
 *     insert/row schema or the wire output format.
 */

const PATTERN = 'test-extinv-%';

/** Fixed clock pinned to an unusual UTC day so daily_cost_usage rows never collide. */
const FIXED_NOW = new Date('1998-11-07T18:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock: Clock = { now: () => FIXED_NOW.getTime() };

/** A redacted transcript the golden phrases quote verbatim, containing NO sentiment word
 *  ('positive'/'neutral'/'negative'/'frustrated') so the sentiment-egress assertion is clean. */
const REDACTED =
  'Caller: my water heater is leaking and it stopped making hot water. I need someone to come out.';

/** A schema-valid, verbatim, PII-free extraction record (snake_case, matching the wire schema). */
const GOLDEN: ExtractionRecord = {
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

/** A range of values that are NOT in the controlled service_category vocabulary. */
const OUT_OF_VOCAB_CATEGORIES = [
  'hvac',
  'electrical',
  'roofing',
  'plumbing', // plausible-but-uncontrolled
  'Water_Heater', // wrong case
  'water heater', // spaces, not the snake_case id
  '', // empty
  'unknown',
] as const;

/** A range of confidence/probability-shaped extra keys a model might smuggle in. */
const CONFIDENCE_LIKE_FIELDS = [
  'confidence',
  'probability',
  'confidence_score',
  'score',
  'certainty',
] as const;

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

// ---------------------------------------------------------------------------
// Part A — pure schema invariants (no DB). These pin the vocabulary/strictness
// contract at the level the handler delegates to (parseExtraction / the wire and
// persisted schemas), so a regression is caught without a database.
// ---------------------------------------------------------------------------

describe('extract invariants — controlled vocabulary (pure)', () => {
  it('every controlled service_category value passes the extraction schema', () => {
    for (const category of SERVICE_CATEGORIES) {
      const parsed = parseExtraction({
        text: JSON.stringify({ ...GOLDEN, service_category: category }),
        stopReason: 'end_turn',
      });
      expect(parsed.ok, `service_category=${category} must parse`).toBe(true);
      if (parsed.ok) expect(parsed.record.service_category).toBe(category);
    }
  });

  it.each(OUT_OF_VOCAB_CATEGORIES)(
    'out-of-vocabulary service_category (%s) is rejected as schema_invalid',
    (category) => {
      const parsed = parseExtraction({
        text: JSON.stringify({ ...GOLDEN, service_category: category }),
        stopReason: 'end_turn',
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.failure).toBe('schema_invalid');
    },
  );

  it('the persisted candidate service_category vocabulary equals the source vocabulary', () => {
    // The extract wire schema, the parse schema, and the persisted row/insert schemas must all
    // pin service_category to the SAME closed set — otherwise a value could pass one gate and be
    // rejected by (or leak past) another.
    expect(EXTRACT_OUTPUT_FORMAT.schema.properties.service_category.enum).toEqual([
      ...SERVICE_CATEGORIES,
    ]);
    for (const category of SERVICE_CATEGORIES) {
      expect(
        extractionCandidateInsertSchema.shape.serviceCategory.safeParse(category).success,
      ).toBe(true);
      expect(extractionCandidateRowSchema.shape.service_category.safeParse(category).success).toBe(
        true,
      );
    }
    expect(extractionCandidateRowSchema.shape.service_category.safeParse('hvac').success).toBe(
      false,
    );
  });
});

describe('extract invariants — no confidence scores (pure)', () => {
  it.each(CONFIDENCE_LIKE_FIELDS)(
    'a smuggled `%s` field is REJECTED (not stripped) by the strict extraction schema',
    (field) => {
      const withExtra = { ...GOLDEN, [field]: 0.97 };
      // Direct schema check: `.strict()` rejects the unknown key rather than dropping it.
      expect(extractionRecordSchema.safeParse(withExtra).success).toBe(false);
      // And through the parser the whole record fails as schema_invalid — never a partial accept.
      const parsed = parseExtraction({ text: JSON.stringify(withExtra), stopReason: 'end_turn' });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.failure).toBe('schema_invalid');
    },
  );

  it('no confidence/probability field exists anywhere in the extract schemas', () => {
    const CONFIDENCE_RE = /confid|probab|score|certain|likelihood/i;
    // Parse (model-output) schema.
    expect(Object.keys(extractionRecordSchema.shape).some((k) => CONFIDENCE_RE.test(k))).toBe(
      false,
    );
    // Persisted insert + row schemas.
    expect(
      Object.keys(extractionCandidateInsertSchema.shape).some((k) => CONFIDENCE_RE.test(k)),
    ).toBe(false);
    expect(Object.keys(extractionCandidateRowSchema.shape).some((k) => CONFIDENCE_RE.test(k))).toBe(
      false,
    );
    // Wire output format: no confidence property AND closed to extras.
    expect(
      Object.keys(EXTRACT_OUTPUT_FORMAT.schema.properties).some((k) => CONFIDENCE_RE.test(k)),
    ).toBe(false);
    expect(EXTRACT_OUTPUT_FORMAT.schema.additionalProperties).toBe(false);
  });
});

describe('extract invariants — sentiment internal-only (pure)', () => {
  it('sentiment is present in the persisted candidate schema (internal store)', () => {
    // Sentiment must persist internally: it is a required field on both the insert and row schemas.
    for (const s of SENTIMENTS) {
      expect(extractionCandidateInsertSchema.shape.sentiment.safeParse(s).success).toBe(true);
      expect(extractionCandidateRowSchema.shape.sentiment.safeParse(s).success).toBe(true);
    }
    // It is REQUIRED (not optional/nullable) on the row — internal analytics always have a value.
    expect(extractionCandidateRowSchema.shape.sentiment.safeParse(undefined).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part B — end-to-end handler invariants (DB-backed). These prove the pure
// contracts above actually govern what the handler persists and emits.
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)('extract stage invariants (handler)', () => {
  let owner!: Pool;
  let app!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  const seed = async (callId: string, redacted = REDACTED): Promise<void> => {
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

  const ctx = (callId: string, logger = silent): StageContext => ({
    callId,
    stage: 'extract',
    logger,
    pool: app,
  });

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

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner, 1);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(
      `DELETE FROM alert_events WHERE error_code IN ('MODEL_MALFORMED_RESPONSE','MODEL_COST_CAP_EXCEEDED')`,
    );
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  // ---- Invariant 1: controlled service_category vocabulary --------------------

  it.each(SERVICE_CATEGORIES)(
    'controlled service_category %s → advances and is persisted verbatim',
    async (category) => {
      const callId = `test-extinv-cat-${category}`;
      await seed(callId);
      const rec = { ...GOLDEN, service_category: category };
      const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
      const res = await handler(() => model)(ctx(callId));

      expect(res.action).toBe('continue');
      const cand = await getExtractionCandidate(app, callId);
      expect(cand?.service_category).toBe(category);
    },
  );

  it.each(OUT_OF_VOCAB_CATEGORIES)(
    'out-of-vocabulary service_category (%s) → held schema_invalid, NOTHING persisted',
    async (category) => {
      const callId = `test-extinv-badcat-${category.replace(/[^a-z]/gi, '') || 'empty'}`;
      await seed(callId);
      const rec = { ...GOLDEN, service_category: category };
      const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
      const res = await handler(() => model)(ctx(callId));

      expect(res.action).toBe('hold');
      if (res.action === 'hold') {
        expect(res.reason).toBe('schema_invalid');
        expect(res.errorCode).toBe('MODEL_MALFORMED_RESPONSE');
        expect(res.detail).toMatchObject({ parse_failure: 'schema_invalid' });
      }
      expect(await countRows('extraction_candidates', callId)).toBe(0);
    },
  );

  // ---- Invariant 2: sentiment internal-only ----------------------------------

  it.each(SENTIMENTS)(
    'sentiment %s is persisted to the internal candidate and NEVER egresses (payload/StageResult/logs)',
    async (sentiment) => {
      const callId = `test-extinv-sent-${sentiment}`;
      const { lines, logger } = collectingLogger();
      await seed(callId);
      const rec = { ...GOLDEN, sentiment };
      const { model, spy } = fakeModel(() =>
        Promise.resolve(result({ text: JSON.stringify(rec) })),
      );
      const res = await handler(() => model)(ctx(callId, logger));

      // Persisted to the internal staging store.
      expect(res.action).toBe('continue');
      const cand = await getExtractionCandidate(app, callId);
      expect(cand?.sentiment).toBe(sentiment);

      // NOT load-bearing: the outbound request is built from buildExtractUserMessage(REDACTED)
      // BEFORE the model responds, so the model's chosen sentiment is structurally unknowable at
      // request-build time and can never appear here — this assertion cannot fail on the real
      // response path. It only guards against a hypothetical future design that echoes an extracted
      // value back into the prompt. The StageResult and log-line checks below are the assertions
      // that actually enforce the internal-only invariant.
      const req = spy.mock.calls[0]?.[0] as { system: string; userText: string };
      expect(req.userText).not.toContain(sentiment);

      // The StageResult that flows onward carries no sentiment.
      expect(JSON.stringify(res)).not.toContain(sentiment);

      // No log line the stage emits contains the sentiment value.
      expect(lines.join('')).not.toContain(sentiment);
    },
  );

  // ---- Invariant 3: no confidence scores ever written -------------------------

  it.each(CONFIDENCE_LIKE_FIELDS)(
    'model response carrying a `%s` field → held schema_invalid, NO candidate written',
    async (field) => {
      const callId = `test-extinv-conf-${field}`;
      await seed(callId);
      const rec = { ...GOLDEN, [field]: 0.97 };
      const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
      const res = await handler(() => model)(ctx(callId));

      expect(res.action).toBe('hold');
      if (res.action === 'hold') {
        expect(res.reason).toBe('schema_invalid');
        expect(res.detail).toMatchObject({ parse_failure: 'schema_invalid' });
      }
      expect(await countRows('extraction_candidates', callId)).toBe(0);
    },
  );

  it('a confidence-carrying response is rejected even though every OTHER field is valid', async () => {
    // Guards the strict-reject (not strip) behavior end to end: the only defect is the extra key.
    const callId = 'test-extinv-conf-otherwise-valid';
    await seed(callId);
    const rec = { ...GOLDEN, confidence: 0.42 };
    const { model } = fakeModel(() => Promise.resolve(result({ text: JSON.stringify(rec) })));
    const res = await handler(() => model)(ctx(callId));

    expect(res.action).toBe('hold');
    if (res.action === 'hold') expect(res.reason).toBe('schema_invalid');
    expect(await countRows('extraction_candidates', callId)).toBe(0);
  });
});
