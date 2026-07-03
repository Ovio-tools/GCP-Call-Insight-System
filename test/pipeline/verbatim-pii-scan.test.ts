import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createVerbatimPiiScanHandler } from '../../src/pipeline/verbatim-pii-scan.js';
import { buildProductionStageHandlers } from '../../src/pipeline/handlers.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import type { StageContext, StageResult } from '../../src/pipeline/stages.js';
import type { DialpadClient } from '../../src/dialpad/client/index.js';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import * as candidatesRepo from '../../src/db/repositories/extraction-candidates-repo.js';
import * as alertRepo from '../../src/db/repositories/alert-events-repo.js';
import type { ExtractionCandidateInsert } from '../../src/db/schemas/extraction-candidates.js';
import { upsertCallState, getCallState } from '../../src/db/repositories/call-state-repo.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import { listByCall as listLogs } from '../../src/db/repositories/processing-log-repo.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool, seedKeyVersion } from '../db/_dal.js';

/**
 * Task 5.2 M6 — the `verbatim-pii-scan` stage. This is the crash-safe, model-free re-verify
 * of the PERSISTED extraction candidate: a candidate reaches pii_scan_status='passed' ONLY
 * after (a) residual-PII scan, (b) token gate, and (c) verbatim recheck all pass. A detected
 * hit latches the failed marker (scrubbing customer_language to [] in one statement) so the
 * hold is re-returnable across a crash, and can never dead-letter or lose its alert.
 *
 * Privacy: no phrase text ever reaches a log line, an alert snapshot, a processing_log
 * detail, a review_queue row, or the serialized pii_scan_counts. PHRASE_MARKER, planted in
 * every gate-tripping phrase, must appear NOWHERE across every failure path.
 */

const PATTERN = 'test-vps-%';

/** A phrase-content marker planted inside gate-tripping phrases; must leak nowhere. */
const PHRASE_MARKER = 'PHRASEMARKERZZZ';

const dialpadStub: DialpadClient = {
  fetchTranscript: vi.fn(() => Promise.resolve({ kind: 'not_ready' as const })),
  listRecentlyConcludedCalls: vi.fn(() => Promise.resolve({ calls: [] })),
};

const keyProvider = new LocalKeyProvider({
  masterKey: Buffer.alloc(DEK_BYTES, 0x07),
  activeKeyVersion: 1,
});

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

/** A full valid candidate insert with the given customer_language phrases. */
function baseCandidate(callId: string, customerLanguage: string[]): ExtractionCandidateInsert {
  return {
    callId,
    callIntent: 'new_booking',
    serviceCategory: 'water_heater',
    problemStatement: 'no hot water',
    symptoms: [],
    customerLanguage,
    locationInHome: null,
    accessOrSchedulingNotes: null,
    priorAttempts: null,
    urgency: 'routine',
    concerns: [],
    sentiment: 'neutral',
    acquisitionSource: null,
    competitorMentions: [],
    schemaVersion: 1,
    promptVersion: 'extract-v1',
    modelId: 'm1',
  };
}

describe.skipIf(!hasTestDb)('verbatim-pii-scan stage', () => {
  let owner!: Pool;
  let app!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  /** Seed call_state@verbatim-pii-scan + clean_transcripts + a candidate (pending). */
  const seed = async (
    callId: string,
    customerLanguage: string[],
    redacted = 'Caller: my water heater is leaking today.',
  ): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'verbatim-pii-scan',
      status: 'processing',
    });
    await upsertCleanTranscript(app, { callId, redactedText: redacted, redactionRiskScore: 0.1 });
    await candidatesRepo.upsertExtractionCandidate(app, baseCandidate(callId, customerLanguage));
  };

  const ctx = (callId: string, logger = silent): StageContext => ({
    callId,
    stage: 'verbatim-pii-scan',
    logger,
    pool: app,
  });

  /** Run the real handler directly (runner NOT involved) and narrow the result. */
  const run = async (
    callId: string,
    logger = silent,
    denyTerms?: readonly string[],
  ): Promise<StageResult> => {
    const config = makeTestConfig();
    const h = createVerbatimPiiScanHandler(denyTerms ? { config, denyTerms } : { config });
    const res = await h(ctx(callId, logger));
    if (!res) throw new Error('handler returned void — a StageResult was expected');
    return res;
  };

  /** Build the full production set so runPipeline routes a hold through holdCall. */
  const set = () => {
    const config = makeTestConfig({
      REDACTION_VALUE_HASH_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    return buildProductionStageHandlers({
      client: dialpadStub,
      keyProvider,
      queue: { add: vi.fn(() => Promise.resolve()) },
      config,
    });
  };

  const rawRow = async (callId: string): Promise<Record<string, unknown> | undefined> => {
    const r = await owner.query(`SELECT * FROM extraction_candidates WHERE call_id = $1`, [callId]);
    return r.rows[0] as Record<string, unknown> | undefined;
  };
  const rowCount = async (table: string, callId: string): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };
  const alertRowsForCall = async (
    code: string,
    callId: string,
  ): Promise<Record<string, unknown>[]> => {
    const r = await owner.query(
      `SELECT * FROM alert_events WHERE error_code = $1 AND failure_snapshot->>'call_id' = $2`,
      [code, callId],
    );
    return r.rows as Record<string, unknown>[];
  };
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
    vi.restoreAllMocks();
    await cleanupCalls(owner, PATTERN);
    await owner.query(
      `DELETE FROM alert_events WHERE error_code IN ('VERBATIM_PII_DETECTED','MODEL_MALFORMED_RESPONSE')`,
    );
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  // ---- clean pass --------------------------------------------------------------

  it('clean candidate → continue and row becomes pii_scan_status=passed', async () => {
    const callId = 'test-vps-clean';
    await seed(callId, ['my water heater is leaking']);
    const res = await run(callId);
    expect(res.action).toBe('continue');
    expect(res).toMatchObject({ detail: { phrases_scanned: 1 } });
    expect((await rawRow(callId))?.pii_scan_status).toBe('passed');
  });

  // ---- residual PII (bypassed extract gate) ------------------------------------

  it('planted-PII candidate → holds VERBATIM_PII_DETECTED, scrubs row, alerts, writes NO review row', async () => {
    const callId = 'test-vps-residual';
    // A phone-shaped digit run (>=7 digits) is a residual hit; PHRASE_MARKER must never leak.
    await seed(callId, [`call me on 5551234567890 ${PHRASE_MARKER}`]);
    const { lines, logger } = collectingLogger();
    const res = await run(callId, logger);

    expect(res).toMatchObject({
      action: 'hold',
      reason: 'residual_pii_detected',
      errorCode: 'VERBATIM_PII_DETECTED',
      detail: { residual_categories: ['digit_run'], counts: { digit_run: 1 } },
    });

    const row = await rawRow(callId);
    expect(row?.customer_language).toEqual([]);
    expect(row?.pii_scan_status).toBe('failed');
    expect(row?.pii_scan_failure_kind).toBe('residual_pii');
    expect(row?.pii_scan_counts).toEqual({ digit_run: 1 });

    // Alert recorded; the handler NEVER writes a review_queue row (that is the runner's job).
    expect(await alertRowsForCall('VERBATIM_PII_DETECTED', callId)).toHaveLength(1);
    expect(await rowCount('review_queue', callId)).toBe(0);

    // Privacy: the phrase content leaks nowhere.
    const out = lines.join('');
    expect(out).not.toContain(PHRASE_MARKER);
    expect(JSON.stringify(row)).not.toContain(PHRASE_MARKER);
    expect(await serializedRows('alert_events', callId)).not.toContain(PHRASE_MARKER);
  });

  // ---- tokened phrase ----------------------------------------------------------

  it('tokened candidate → scrubbed, latched tokened_phrase, holds schema_invalid, never passes', async () => {
    const callId = 'test-vps-tokened';
    await seed(callId, [`[NAME_1] ${PHRASE_MARKER}`]);
    const { lines, logger } = collectingLogger();
    const res = await run(callId, logger);

    expect(res).toMatchObject({
      action: 'hold',
      reason: 'schema_invalid',
      errorCode: 'MODEL_MALFORMED_RESPONSE',
      detail: { gate: 'tokened_phrase', dropped_count: 1 },
    });
    const row = await rawRow(callId);
    expect(row?.customer_language).toEqual([]);
    expect(row?.pii_scan_status).toBe('failed');
    expect(row?.pii_scan_failure_kind).toBe('tokened_phrase');
    expect(row?.pii_scan_counts).toEqual({ dropped_count: 1 });
    // Latched: a subsequent pass can never un-fail it.
    expect(await candidatesRepo.markPiiScanPassed(app, callId)).toBeUndefined();
    expect((await rawRow(callId))?.pii_scan_status).toBe('failed');

    expect(lines.join('')).not.toContain(PHRASE_MARKER);
    expect(JSON.stringify(row)).not.toContain(PHRASE_MARKER);
  });

  // ---- non-verbatim ------------------------------------------------------------

  it('non-verbatim PII-free candidate → scrubbed, latched verbatim_mismatch, holds schema_invalid', async () => {
    const callId = 'test-vps-verbatim';
    await seed(callId, [`this line never appears ${PHRASE_MARKER}`], 'Totally different content.');
    const { lines, logger } = collectingLogger();
    const res = await run(callId, logger);

    expect(res).toMatchObject({
      action: 'hold',
      reason: 'schema_invalid',
      errorCode: 'MODEL_MALFORMED_RESPONSE',
      detail: { gate: 'verbatim_mismatch', mismatch_count: 1, phrase_count: 1 },
    });
    const row = await rawRow(callId);
    expect(row?.customer_language).toEqual([]);
    expect(row?.pii_scan_status).toBe('failed');
    expect(row?.pii_scan_failure_kind).toBe('verbatim_mismatch');
    expect(row?.pii_scan_counts).toEqual({ mismatch_count: 1, phrase_count: 1 });
    expect(await candidatesRepo.markPiiScanPassed(app, callId)).toBeUndefined();

    expect(lines.join('')).not.toContain(PHRASE_MARKER);
    expect(JSON.stringify(row)).not.toContain(PHRASE_MARKER);
  });

  // ---- crash recovery ----------------------------------------------------------

  it('crash after failed-marker (no alert) → re-returns the SAME hold without re-scanning, records the missing alert', async () => {
    const callId = 'test-vps-crash';
    await seed(callId, ['my water heater is leaking']);
    // Simulate the marker write that a crash interrupted BEFORE the alert / holdCall.
    await candidatesRepo.markPiiScanFailed(app, callId, {
      kind: 'residual_pii',
      counts: { digit_run: 1 },
    });
    expect(await alertRowsForCall('VERBATIM_PII_DETECTED', callId)).toHaveLength(0);

    const res = await run(callId);
    // Same hold, from the STORED counts (a fresh scan of the scrubbed [] could never re-derive
    // a residual hit, proving the fast path was taken).
    expect(res).toMatchObject({
      action: 'hold',
      reason: 'residual_pii_detected',
      errorCode: 'VERBATIM_PII_DETECTED',
      detail: { residual_categories: ['digit_run'], counts: { digit_run: 1 } },
    });
    expect(await alertRowsForCall('VERBATIM_PII_DETECTED', callId)).toHaveLength(1);
  });

  it('retry when the alert already exists → deduped, no duplicate alert row', async () => {
    const callId = 'test-vps-dedup';
    await seed(callId, ['my water heater is leaking']);
    await candidatesRepo.markPiiScanFailed(app, callId, {
      kind: 'residual_pii',
      counts: { digit_run: 1 },
    });
    await run(callId);
    await run(callId);
    expect(await alertRowsForCall('VERBATIM_PII_DETECTED', callId)).toHaveLength(1);
  });

  it('alert-insert failure still returns the residual hold (resilientSideEffect lets the hold win)', async () => {
    const callId = 'test-vps-alert-fail';
    await seed(callId, [`ring 5551234567890 ${PHRASE_MARKER}`]);
    vi.spyOn(alertRepo, 'recordAlert').mockRejectedValue(new Error('alert insert boom'));
    const res = await run(callId);
    expect(res).toMatchObject({ action: 'hold', reason: 'residual_pii_detected' });
    // markPiiScanFailed ran BEFORE the alert, so the row is already scrubbed + latched.
    const row = await rawRow(callId);
    expect(row?.pii_scan_status).toBe('failed');
    expect(row?.customer_language).toEqual([]);
  });

  // ---- latch race --------------------------------------------------------------

  it('latch race: a concurrent fail before markPiiScanPassed → pass is a zero-row no-op, re-read holds', async () => {
    const callId = 'test-vps-latch-race';
    await seed(callId, ['my water heater is leaking']);
    // Simulate a concurrent fail landing between the gate checks and the conditional pass.
    vi.spyOn(candidatesRepo, 'markPiiScanPassed').mockImplementation(async (pool, id) => {
      await candidatesRepo.markPiiScanFailed(pool, id, {
        kind: 'residual_pii',
        counts: { digit_run: 1 },
      });
      return undefined;
    });
    const res = await run(callId);
    expect(res).toMatchObject({
      action: 'hold',
      reason: 'residual_pii_detected',
      errorCode: 'VERBATIM_PII_DETECTED',
    });
    expect((await rawRow(callId))?.pii_scan_status).toBe('failed');
  });

  it('idempotent re-read: an already-passed candidate → continue (no-op pass)', async () => {
    const callId = 'test-vps-already-passed';
    await seed(callId, ['my water heater is leaking']);
    await candidatesRepo.markPiiScanPassed(app, callId);
    const res = await run(callId);
    expect(res).toMatchObject({ action: 'continue', detail: { phrases_scanned: 1 } });
    expect((await rawRow(callId))?.pii_scan_status).toBe('passed');
  });

  // ---- invariant throws --------------------------------------------------------

  it('missing candidate → throws', async () => {
    const callId = 'test-vps-no-candidate';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'verbatim-pii-scan',
      status: 'processing',
    });
    await expect(run(callId)).rejects.toThrow();
  });

  it('missing clean transcript → throws', async () => {
    const callId = 'test-vps-no-clean';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'verbatim-pii-scan',
      status: 'processing',
    });
    await candidatesRepo.upsertExtractionCandidate(
      app,
      baseCandidate(callId, ['my water heater is leaking']),
    );
    await expect(run(callId)).rejects.toThrow();
  });

  // ---- runner integration ------------------------------------------------------

  it('runPipeline on a failed-marker candidate → one open residual review, held, log carries errorCode, re-run no-op', async () => {
    const callId = 'test-vps-runner';
    await seed(callId, [`leak at 5551234567890 ${PHRASE_MARKER}`]);
    // Latch the failed marker (scrubs the phrase); the handler will re-return the hold.
    await candidatesRepo.markPiiScanFailed(app, callId, {
      kind: 'residual_pii',
      counts: { digit_run: 1 },
    });

    await runPipeline(app, callId, silent, set());

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held');
    expect(state?.current_stage).toBe('verbatim-pii-scan');

    const reviews = await owner.query<{ held_reason: string; status: string }>(
      `SELECT held_reason, status FROM review_queue WHERE call_id = $1`,
      [callId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]?.held_reason).toBe('residual_pii_detected');
    expect(reviews.rows[0]?.status).toBe('open');

    const log = (await listLogs(app, callId)).find((r) => r.stage === 'verbatim-pii-scan');
    expect(log?.outcome).toBe('held');
    expect(log?.error_code).toBe('VERBATIM_PII_DETECTED');

    // Re-running a held call is a terminal no-op (no second review row, no second alert).
    await runPipeline(app, callId, silent, set());
    expect(await rowCount('review_queue', callId)).toBe(1);
    expect(await alertRowsForCall('VERBATIM_PII_DETECTED', callId)).toHaveLength(1);

    // Privacy: the phrase content leaks into NONE of the persisted surfaces.
    for (const table of [
      'review_queue',
      'processing_log',
      'alert_events',
      'extraction_candidates',
    ]) {
      expect(
        await serializedRows(table, callId),
        `${table} must not contain the phrase marker`,
      ).not.toContain(PHRASE_MARKER);
    }
  });
});
