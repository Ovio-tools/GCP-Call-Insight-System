import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  type ModelTextResult,
  type TechnicianNoteModelClient,
  ModelApiError,
} from '../../src/anthropic/client.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import {
  softDeleteCleanTranscript,
  upsertCleanTranscript,
} from '../../src/db/repositories/clean-transcripts-repo.js';
import { listByCall as listInvocations } from '../../src/db/repositories/model-invocations-repo.js';
import { listByCall as listLogs } from '../../src/db/repositories/processing-log-repo.js';
import { getTechnicianNote } from '../../src/db/repositories/technician-notes-repo.js';
import { upsertStructuredKnowledge } from '../../src/db/repositories/structured-knowledge-repo.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { utcDay } from '../../src/model/cost.js';
import {
  TECHNICIAN_NOTE_PROMPT_VERSION,
  TECHNICIAN_NOTE_SCHEMA_VERSION,
  TECHNICIAN_NOTE_STAGE,
  TechnicianNoteError,
  createTechnicianNoteGenerator,
} from '../../src/technician-notes/index.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { expectedRecord, fixtureByName } from './fixtures.js';

const PATTERN = 'test-note-%';

/** A fixed clock on an unusual UTC day so daily_cost_usage rows never collide with siblings. */
const FIXED_NOW = new Date('1997-03-19T12:00:00Z');
const FIXED_DAY = utcDay(FIXED_NOW);
const clock = { now: (): number => FIXED_NOW.getTime() };

const GOLDEN = fixtureByName('golden-drain-clog');

function result(over: Partial<ModelTextResult> = {}): ModelTextResult {
  return {
    text: GOLDEN.modelResponse.text,
    stopReason: 'end_turn',
    inputTokens: 2000,
    outputTokens: 300,
    usagePresent: true,
    ...over,
  };
}

function fakeModel(impl: TechnicianNoteModelClient['generate']): {
  model: TechnicianNoteModelClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return { model: { generate: spy }, spy };
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

describe.skipIf(!hasTestDb)('technician-note generator', () => {
  let owner!: Pool;
  let app!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  /** Seed a completed call with a knowledge row and a readable clean transcript. */
  const seed = async (callId: string, redacted = GOLDEN.redactedTranscript): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'mark-retention-eligible',
      status: 'completed',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
    await upsertStructuredKnowledge(app, {
      callId,
      callIntent: 'new_booking',
      serviceCategory: 'drain_blockage',
      urgency: 'routine',
      sentiment: 'neutral',
      schemaVersion: 1,
      promptVersion: 'extract-v3',
      modelId: 'test-model',
    });
  };

  function generator(
    getModel: () => TechnicianNoteModelClient,
    overrides: Record<string, unknown> = {},
    logger = silent,
  ): ReturnType<typeof createTechnicianNoteGenerator> {
    const config = makeTestConfig({ TECHNICIAN_NOTES_ENABLED: true, ...overrides });
    return createTechnicianNoteGenerator({ pool: app, config, logger, getModel, clock });
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

  beforeAll(async () => {
    owner = makePool();
    await migrate('up');
    app = makeAppPool();
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [FIXED_DAY]);
    await owner.query(`DELETE FROM alert_events WHERE error_code IN
      ('MODEL_COST_CAP_EXCEEDED','MODEL_AUTH_FAILED','MODEL_RATE_LIMITED','VERBATIM_PII_DETECTED',
       'MODEL_COST_WARNING_THRESHOLD_EXCEEDED')`);
  });

  describe('construction guards', () => {
    const config = makeTestConfig({ TECHNICIAN_NOTES_ENABLED: true });

    it('throws when handed a key provider', () => {
      expect(() =>
        createTechnicianNoteGenerator({
          pool: app,
          config,
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
          // A KeyProvider smuggled in as an extra dependency.
          ...({
            keys: { getDek: () => Promise.resolve(Buffer.alloc(32)), currentKeyVersion: () => 1 },
          } as object),
        }),
      ).toThrow(TechnicianNoteError);
    });

    it('names raw_store_access_forbidden as the refusal reason for a key provider', () => {
      try {
        createTechnicianNoteGenerator({
          pool: app,
          config,
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
          ...({ keys: { unwrapDek: () => Promise.resolve(Buffer.alloc(32)) } } as object),
        });
        expect.unreachable('expected a TechnicianNoteError');
      } catch (err) {
        expect(err).toBeInstanceOf(TechnicianNoteError);
        expect((err as TechnicianNoteError).reason).toBe('raw_store_access_forbidden');
      }
    });

    it('throws when handed a KeyStore', () => {
      expect(() =>
        createTechnicianNoteGenerator({
          pool: app,
          config,
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
          ...({
            store: { recoverability: () => Promise.resolve(false), destroyDek: () => {} },
          } as object),
        }),
      ).toThrow(/key-material access/);
    });

    it('throws when handed the raw-store (DB-B) pool', () => {
      const rawUrl = 'postgres://user:pw@localhost:5433/gcp_raw_test';
      const rawish = { query: () => undefined, options: { connectionString: rawUrl } };
      expect(() =>
        createTechnicianNoteGenerator({
          pool: rawish as unknown as Pool,
          config: makeTestConfig({
            TECHNICIAN_NOTES_ENABLED: true,
            RAW_DATABASE_URL: rawUrl,
          }),
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
        }),
      ).toThrow(/raw-store \(DB-B\) pool/);
    });

    it('throws when handed a restricted (vault) runner instead of a pool', () => {
      expect(() =>
        createTechnicianNoteGenerator({
          pool: { run: () => undefined } as unknown as Pool,
          config,
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
        }),
      ).toThrow(/restricted \(vault\) runner/);
    });

    it('accepts the ordinary application pool', () => {
      expect(() =>
        createTechnicianNoteGenerator({
          pool: app,
          config,
          logger: silent,
          getModel: () => ({ generate: vi.fn() }),
        }),
      ).not.toThrow();
    });
  });

  describe('the happy path', () => {
    it('writes a note, records the invocation, and logs a completed row', async () => {
      const callId = 'test-note-happy';
      await seed(callId);
      const { model, spy } = fakeModel(() => Promise.resolve(result()));

      const outcome = await generator(() => model)(callId);
      expect(outcome.outcome).toBe('generated');

      const note = await getTechnicianNote(app, callId);
      expect(note).toBeDefined();
      expect(note?.prompt_version).toBe(TECHNICIAN_NOTE_PROMPT_VERSION);
      expect(note?.schema_version).toBe(TECHNICIAN_NOTE_SCHEMA_VERSION);
      expect(note?.symptom_verbatim).toBe(expectedRecord(GOLDEN).symptom_verbatim);
      expect(spy).toHaveBeenCalledTimes(1);

      const invocations = await listInvocations(app, callId);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.stage).toBe(TECHNICIAN_NOTE_STAGE);
      expect(invocations[0]?.prompt_version).toBe(TECHNICIAN_NOTE_PROMPT_VERSION);
      expect(invocations[0]?.model_id).toBe(makeTestConfig().TECHNICIAN_NOTE_MODEL_ID);
      expect(invocations[0]?.outcome).toBe('success');

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.outcome).toBe('completed');
    });

    it('writes the deterministic gap list, not one the model authored', async () => {
      const callId = 'test-note-gaps';
      await seed(callId);
      const { model } = fakeModel(() => Promise.resolve(result()));
      await generator(() => model)(callId);

      const note = await getTechnicianNote(app, callId);
      expect(note?.not_established).toEqual(GOLDEN.expectedNotEstablished);
    });

    it('is idempotent: a second run replaces the note rather than duplicating it', async () => {
      const callId = 'test-note-idempotent';
      await seed(callId);
      const { model } = fakeModel(() => Promise.resolve(result()));

      await generator(() => model)(callId);
      await generator(() => model)(callId);

      expect(await countRows('technician_notes', callId)).toBe(1);
    });

    it('never writes a review_queue row on the happy path', async () => {
      const callId = 'test-note-noqueue-ok';
      await seed(callId);
      const { model } = fakeModel(() => Promise.resolve(result()));
      await generator(() => model)(callId);
      expect(await countRows('review_queue', callId)).toBe(0);
    });
  });

  describe('a missing clean transcript', () => {
    it('skips and counts a call whose clean transcript is soft-deleted, writing no row', async () => {
      const callId = 'test-note-softdel';
      await seed(callId);
      await softDeleteCleanTranscript(app, callId);
      const { model, spy } = fakeModel(() => Promise.resolve(result()));

      const outcome = await generator(() => model)(callId);

      expect(outcome.outcome).toBe('skipped_no_transcript');
      expect(spy).not.toHaveBeenCalled();
      expect(await countRows('technician_notes', callId)).toBe(0);
      expect(await countRows('model_invocations', callId)).toBe(0);
      expect(await countRows('review_queue', callId)).toBe(0);

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.outcome).toBe('skipped');
      expect(logs[0]?.detail).toEqual({ reason: 'no_clean_transcript' });
    });

    it('skips a call with no clean transcript at all', async () => {
      const callId = 'test-note-notranscript';
      await upsertCallState(app, {
        callId,
        source: 'test',
        currentStage: 'mark-retention-eligible',
        status: 'completed',
      });
      const { model, spy } = fakeModel(() => Promise.resolve(result()));

      expect((await generator(() => model)(callId)).outcome).toBe('skipped_no_transcript');
      expect(spy).not.toHaveBeenCalled();
    });

    it('never falls back to the structured_knowledge record', async () => {
      const callId = 'test-note-nofallback';
      await seed(callId);
      await softDeleteCleanTranscript(app, callId);
      const { model, spy } = fakeModel(() => Promise.resolve(result()));

      await generator(() => model)(callId);

      // The knowledge row is still there and untouched — it was simply never used as input.
      expect(await countRows('structured_knowledge', callId)).toBe(1);
      expect(spy).not.toHaveBeenCalled();
      expect(await countRows('technician_notes', callId)).toBe(0);
    });
  });

  describe('malformed model output', () => {
    it('retries once, then records the outcome and writes nothing', async () => {
      const callId = 'test-note-malformed';
      await seed(callId);
      const before = await owner.query(`SELECT * FROM structured_knowledge WHERE call_id = $1`, [
        callId,
      ]);
      const { model, spy } = fakeModel(() => Promise.resolve(result({ text: 'not json' })));

      const outcome = await generator(() => model)(callId);

      expect(outcome.outcome).toBe('failed_schema');
      // Exactly ONE bounded retry: two calls total, never three.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await countRows('technician_notes', callId)).toBe(0);
      expect(await countRows('review_queue', callId)).toBe(0);

      const after = await owner.query(`SELECT * FROM structured_knowledge WHERE call_id = $1`, [
        callId,
      ]);
      expect(after.rows).toEqual(before.rows);

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.outcome).toBe('failed');
      expect(logs[0]?.detail).toMatchObject({ reason: 'schema_invalid', retry_attempted: true });
    });

    it('succeeds when the retry returns valid output', async () => {
      const callId = 'test-note-retry-ok';
      await seed(callId);
      let call = 0;
      const { model, spy } = fakeModel(() => {
        call += 1;
        return Promise.resolve(call === 1 ? result({ text: 'not json' }) : result());
      });

      expect((await generator(() => model)(callId)).outcome).toBe('generated');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await getTechnicianNote(app, callId)).toBeDefined();
    });

    it('does NOT retry a refusal', async () => {
      const callId = 'test-note-refusal';
      await seed(callId);
      const { model, spy } = fakeModel(() =>
        Promise.resolve(result({ text: 'no', stopReason: 'refusal' })),
      );

      expect((await generator(() => model)(callId)).outcome).toBe('failed_schema');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a truncated response', async () => {
      const callId = 'test-note-truncated';
      await seed(callId);
      const { model, spy } = fakeModel(() => Promise.resolve(result({ stopReason: 'max_tokens' })));

      expect((await generator(() => model)(callId)).outcome).toBe('failed_schema');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('records an invocation for each attempt, marked malformed_response', async () => {
      const callId = 'test-note-invocations';
      await seed(callId);
      const { model } = fakeModel(() => Promise.resolve(result({ text: 'not json' })));
      await generator(() => model)(callId);

      const invocations = await listInvocations(app, callId);
      expect(invocations).toHaveLength(2);
      for (const inv of invocations) {
        expect(inv.outcome).toBe('malformed_response');
        expect(inv.stage).toBe(TECHNICIAN_NOTE_STAGE);
      }
    });
  });

  describe('a thrown model error', () => {
    it('records failed_model and writes no note or review-queue row', async () => {
      const callId = 'test-note-modelerr';
      await seed(callId);
      const { model, spy } = fakeModel(() =>
        Promise.reject(new ModelApiError('rate_limited', 'not_billed', 429)),
      );

      const outcome = await generator(() => model)(callId);

      expect(outcome.outcome).toBe('failed_model');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await countRows('technician_notes', callId)).toBe(0);
      expect(await countRows('review_queue', callId)).toBe(0);
      expect(await alertCount('MODEL_RATE_LIMITED')).toBe(1);

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      expect(logs[0]?.detail).toMatchObject({ reason: 'model_error', attempt: 1 });
    });

    it('does not abort the batch — it returns an outcome rather than throwing', async () => {
      const callId = 'test-note-modelerr-noThrow';
      await seed(callId);
      const { model } = fakeModel(() =>
        Promise.reject(new ModelApiError('auth', 'not_billed', 401)),
      );
      await expect(generator(() => model)(callId)).resolves.toMatchObject({
        outcome: 'failed_model',
      });
    });
  });

  describe('the daily cost cap', () => {
    it('returns cost_cap without calling the model or writing a note', async () => {
      const callId = 'test-note-costcap';
      await seed(callId);
      const { model, spy } = fakeModel(() => Promise.resolve(result()));

      const outcome = await generator(() => model, { DAILY_MODEL_COST_CAP_USD: 0.0000001 })(callId);

      expect(outcome.outcome).toBe('cost_cap');
      expect(spy).not.toHaveBeenCalled();
      expect(await countRows('technician_notes', callId)).toBe(0);
      expect(await countRows('review_queue', callId)).toBe(0);
      expect(await alertCount('MODEL_COST_CAP_EXCEEDED')).toBe(1);
    });

    it('scopes the cap alert by component, since technician-note is not a pipeline stage', async () => {
      const callId = 'test-note-costcap-ctx';
      await seed(callId);
      const { model } = fakeModel(() => Promise.resolve(result()));
      await generator(() => model, { DAILY_MODEL_COST_CAP_USD: 0.0000001 })(callId);

      const r = await owner.query<{ failure_snapshot: Record<string, unknown> }>(
        `SELECT failure_snapshot FROM alert_events WHERE error_code = 'MODEL_COST_CAP_EXCEEDED'`,
      );
      const context = r.rows[0]?.failure_snapshot.context as Record<string, string>;
      expect(context.component).toBe('technician-notes');
      // `stage` is validated against isPipelineStage and dropped — this is why `component` is
      // threaded through at all.
      expect(context.stage).toBeUndefined();
    });
  });

  describe('the residual scan over model output', () => {
    const PII = fixtureByName('adversarial-planted-pii-symptom');

    it('nulls the offending field, writes the note anyway, and never holds', async () => {
      const callId = 'test-note-residual';
      await seed(callId, PII.redactedTranscript);
      const { model } = fakeModel(() => Promise.resolve(result({ text: PII.modelResponse.text })));

      const outcome = await generator(() => model)(callId);

      expect(outcome.outcome).toBe('generated');
      expect(outcome.residualCounts?.digit_run).toBeGreaterThan(0);

      const note = await getTechnicianNote(app, callId);
      expect(note?.symptom_verbatim).toBeNull();
      expect(note?.access_notes).toBe('knock loudly, doorbell is broken');
      // NOT held: no review_queue row, and the note is stored with the field cleared.
      expect(await countRows('review_queue', callId)).toBe(0);
    });

    it('records the counts-only category in the processing_log detail', async () => {
      const callId = 'test-note-residual-log';
      await seed(callId, PII.redactedTranscript);
      const { model } = fakeModel(() => Promise.resolve(result({ text: PII.modelResponse.text })));
      await generator(() => model)(callId);

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      const detail = logs[0]?.detail as Record<string, unknown>;
      expect(detail.residual_hit).toBe(true);
      expect(detail.residual_categories).toEqual(['digit_run']);
      expect(detail.residual_fields_nulled).toEqual(['symptom_verbatim']);
      // Counts only — the offending value appears nowhere.
      expect(JSON.stringify(detail)).not.toContain('5551234567');
    });

    it('records a deduped VERBATIM_PII_DETECTED alert', async () => {
      const callId = 'test-note-residual-alert';
      await seed(callId, PII.redactedTranscript);
      const { model } = fakeModel(() => Promise.resolve(result({ text: PII.modelResponse.text })));
      await generator(() => model)(callId);
      expect(await alertCount('VERBATIM_PII_DETECTED')).toBe(1);
    });
  });

  describe('privacy', () => {
    it('puts no transcript content, note value, or SDK message into any log line', async () => {
      const callId = 'test-note-privacy';
      const secret = 'the kitchen sink will not drain';
      await seed(callId);
      const { lines, logger } = collectingLogger();
      const { model } = fakeModel(() => Promise.resolve(result()));

      await generator(() => model, {}, logger)(callId);

      const joined = lines.join('\n');
      expect(joined).not.toContain(secret);
      expect(joined).not.toContain('side door is the easiest way in');
      expect(joined).not.toContain(GOLDEN.redactedTranscript);
      // The call id and the stage DO appear — that is the traceability contract.
      expect(joined).toContain(callId);
      expect(joined).toContain(TECHNICIAN_NOTE_STAGE);
    });

    it('never logs a raw SDK error message', async () => {
      const callId = 'test-note-privacy-sdk';
      await seed(callId);
      const { lines, logger } = collectingLogger();
      const { model } = fakeModel(() =>
        Promise.reject(new Error('Anthropic said: transcript body 5551234567')),
      );

      await generator(() => model, {}, logger)(callId);

      const joined = lines.join('\n');
      expect(joined).not.toContain('5551234567');
      expect(joined).not.toContain('transcript body');
    });

    it('never persists the zod issue summary, which can embed the received value', async () => {
      const callId = 'test-note-privacy-issues';
      await seed(callId);
      const badRecord = JSON.parse(GOLDEN.modelResponse.text as string) as Record<string, unknown>;
      badRecord.location_on_property = 'SECRET-VALUE-IN-OUTPUT';
      badRecord.scope_signal = 'not_a_real_scope';
      const { model } = fakeModel(() =>
        Promise.resolve(result({ text: JSON.stringify(badRecord) })),
      );

      await generator(() => model)(callId);

      const logs = (await listLogs(app, callId)).filter((l) => l.stage === TECHNICIAN_NOTE_STAGE);
      expect(JSON.stringify(logs)).not.toContain('SECRET-VALUE-IN-OUTPUT');
      expect(JSON.stringify(logs)).not.toContain('not_a_real_scope');
    });
  });
});
