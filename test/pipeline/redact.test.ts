import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { createRedactionHandler } from '../../src/pipeline/redact.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import type { StageContext, StageHandlers } from '../../src/pipeline/stages.js';
import { defaultStageHandlers } from '../../src/pipeline/stages.js';
import { getCallState, upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import {
  getCleanTranscript,
  upsertCleanTranscript,
} from '../../src/db/repositories/clean-transcripts-repo.js';
import { getFindings } from '../../src/db/repositories/redaction-findings-repo.js';
import { putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { getToken } from '../../src/db/restricted/token-vault-repo.js';
import { ConfigError } from '../../src/config/index.js';
import { assertNoContentFields } from '../../src/logging/redaction.js';
import { createRootLogger } from '../../src/logging/logger.js';
import type { Detector, DetectorResult } from '../../src/redaction/types.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-rd-%';
const HASH_KEY = Buffer.alloc(32, 0x5a).toString('base64');

/** A deterministic fake detector returning fixed detections/signals. */
function fakeDetector(name: string, result: Partial<DetectorResult>): Detector {
  return {
    name,
    detect: () => Promise.resolve({ detections: [], riskSignals: [], ...result }),
  };
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

describe.skipIf(!hasTestDb)('redact stage', () => {
  let owner!: Pool;
  let app!: Pool;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });
  const config = makeTestConfig({ REDACTION_VALUE_HASH_KEY: HASH_KEY });

  //                    0         1         2         3         4
  //                    0123456789012345678901234567890123456789012345
  const TRANSCRIPT =
    'Hi, John Smith here, call me on 9165551234 about the job, ' +
    'the water heater is still leaking and we need someone this week';
  const NAME_SPAN = { start: 4, end: 14 } as const; // "John Smith"
  const PHONE_SPAN = { start: 32, end: 42 } as const; // "9165551234"

  /** The happy-path fake layer-1: finds the name + phone, no signals. */
  const happyDetector = (): Detector =>
    fakeDetector('fake', {
      detections: [
        { ...NAME_SPAN, entityType: 'name', detector: 'ner', confidence: 0.99 },
        { ...PHONE_SPAN, entityType: 'phone', detector: 'regex' },
      ],
    });

  const seedProcessing = async (callId: string, transcript = TRANSCRIPT): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'redact',
      status: 'processing',
    });
    await putTranscript(app, keyProvider, { callId, transcript });
  };

  const makeHandler = (detectors: Detector[], overrides: Partial<typeof config> = {}) =>
    createRedactionHandler({
      keyProvider,
      config: { ...config, ...overrides },
      detectors,
      denyTerms: [],
    });

  const ctx = (callId: string, logger = collectingLogger().logger): StageContext => ({
    callId,
    stage: 'redact',
    logger,
    pool: app,
  });

  /** Runs a handler and narrows away the `void` (= continue) variant for assertions. */
  const run = async (
    handler: ReturnType<typeof makeHandler>,
    c: StageContext,
  ): Promise<Exclude<Awaited<ReturnType<typeof handler>>, void>> => {
    const result = await handler(c);
    if (!result) throw new Error('handler returned void');
    return result;
  };

  const alertCount = async (): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_events WHERE error_code = 'REDACTION_LOW_CONFIDENCE'`,
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
    await owner.query(`DELETE FROM alert_events WHERE error_code = 'REDACTION_LOW_CONFIDENCE'`);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('happy path: vault round-trips byte-exact, findings carry refs/hashes only, clean row written, advances', async () => {
    const callId = 'test-rd-happy';
    await seedProcessing(callId);
    const result = await makeHandler([happyDetector()])(ctx(callId));
    expect(result).toEqual({ action: 'continue' });

    // Clean transcript: tokens in, PII out.
    const clean = await getCleanTranscript(app, callId);
    expect(clean?.redacted_text).toBe(
      'Hi, [NAME_1] here, call me on [PHONE_1] about the job, ' +
        'the water heater is still leaking and we need someone this week',
    );
    expect(Number(clean?.redaction_risk_score)).toBe(0);

    // Vault round-trip through the envelope helper is byte-exact.
    const runner = createRestrictedRunner(app);
    const name = await getToken(runner, keyProvider, { callId, token: '[NAME_1]' });
    const phone = await getToken(runner, keyProvider, { callId, token: '[PHONE_1]' });
    expect(name?.toString('utf8')).toBe('John Smith');
    expect(phone?.toString('utf8')).toBe('9165551234');

    // Findings: token refs + value hashes + the call-level residual row; NO raw values
    // in any column of the row set.
    const findings = await getFindings(app, callId);
    expect(findings).toHaveLength(3);
    const residualRow = findings.find((f) => f.entity_type === 'residual_scan');
    expect(residualRow).toBeDefined();
    expect(residualRow?.token_ref).toBeNull();
    expect(residualRow?.value_hash).toBeNull();
    const tokenRows = findings.filter((f) => f.entity_type !== 'residual_scan');
    for (const row of tokenRows) {
      expect(row.token_ref).toMatch(/^\[[A-Z_]+_\d+\]$/);
      expect(row.value_hash).toBeInstanceOf(Buffer);
      expect(row.value_hash!.length).toBe(32);
    }
    const dump = JSON.stringify(findings, (_k, v: unknown) =>
      Buffer.isBuffer(v) ? v.toString('hex') : v,
    );
    expect(dump).not.toContain('John');
    expect(dump).not.toContain('Smith');
    expect(dump).not.toContain('9165551234');
  });

  it('downstream egress contract: a classify stub reading getCleanTranscript sees only redacted text', async () => {
    const callId = 'test-rd-downstream';
    await seedProcessing(callId);
    const { logger } = collectingLogger();

    let classifySaw: string | undefined;
    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      redact: makeHandler([happyDetector()]),
      classify: async (c) => {
        classifySaw = (await getCleanTranscript(c.pool, c.callId))?.redacted_text;
        return { action: 'continue' };
      },
    };
    await runPipeline(app, callId, logger, handlers);

    expect(classifySaw).toBe(
      'Hi, [NAME_1] here, call me on [PHONE_1] about the job, ' +
        'the water heater is still leaking and we need someone this week',
    );
    expect(classifySaw).not.toContain('John Smith');
    expect(classifySaw).not.toContain('9165551234');
  });

  it('low-confidence NER: the span is still redacted, never passed through', async () => {
    const callId = 'test-rd-lowconf';
    await seedProcessing(callId);
    const lowConf = fakeDetector('fake', {
      detections: [{ ...NAME_SPAN, entityType: 'name', detector: 'ner', confidence: 0.3 }],
      riskSignals: [{ reason: 'ner_low_confidence' }],
    });
    const result = await run(makeHandler([lowConf]), ctx(callId));

    // Whatever the disposition, "John Smith" must not survive in readable clean text.
    const clean = await getCleanTranscript(app, callId);
    if (result.action === 'continue') {
      expect(clean?.redacted_text).toContain('[NAME_1]');
      expect(clean?.redacted_text).not.toContain('John Smith');
    } else {
      expect(result.action).toBe('hold');
      if (clean) expect(clean.redacted_text).not.toContain('John Smith');
    }
  });

  it('residual bypass: an email layer-1 missed is caught, held residual_pii_detected, no clean row, residual finding persisted', async () => {
    const callId = 'test-rd-residual';
    // Layer-1 (fake) misses the confusable-@ email entirely — it is NOT in the vault.
    const planted = 'contact me at john＠example.com for the invoice';
    await seedProcessing(callId, planted);
    const result = await makeHandler([fakeDetector('fake', {})])(ctx(callId));

    expect(result).toMatchObject({
      action: 'hold',
      reason: 'residual_pii_detected',
      errorCode: 'REDACTION_LOW_CONFIDENCE',
    });

    // No readable clean row.
    expect(await getCleanTranscript(app, callId)).toBeUndefined();

    // The call-level residual finding is persisted with categories/counts only.
    const findings = await getFindings(app, callId);
    const residualRow = findings.find((f) => f.entity_type === 'residual_scan');
    expect(residualRow).toBeDefined();
    const scanResult = residualRow!.residual_scan_result as {
      categories: string[];
      counts: Record<string, number>;
    };
    expect(scanResult.categories).toContain('email_like');
    expect(JSON.stringify(scanResult)).not.toContain('john');

    // Exactly one open review row once the runner performs the hold — covered below in
    // the runPipeline variant; here the handler returned the hold result.
    expect(await alertCount()).toBe(1);
  });

  it('stale-clean rerun: pass then residual-trip soft-deletes the old clean row; a passing rerun restores it', async () => {
    const callId = 'test-rd-stale';
    await seedProcessing(callId);

    // 1. Pass: clean row exists.
    await makeHandler([happyDetector()])(ctx(callId));
    expect(await getCleanTranscript(app, callId)).toBeDefined();

    // 2. Rerun with a residual-tripping fake (vault recheck: detector "finds" the name
    //    but the tokenizer output is sabotaged by leaving the phone undetected as a
    //    digit run). Simplest: no detections at all — the raw digits trip digit_run.
    const rerun = await makeHandler([fakeDetector('fake', {})])(ctx(callId));
    expect(rerun).toMatchObject({ action: 'hold', reason: 'residual_pii_detected' });
    expect(await getCleanTranscript(app, callId)).toBeUndefined();

    // 3. Passing rerun restores an active clean row (upsert clears soft_deleted_at).
    await makeHandler([happyDetector()])(ctx(callId));
    const restored = await getCleanTranscript(app, callId);
    expect(restored?.redacted_text).toContain('[NAME_1]');
  });

  it('hard-delete guard: a retention-final call aborts BEFORE any write — nothing repopulated', async () => {
    const callId = 'test-rd-harddel';
    await seedProcessing(callId);
    await upsertCleanTranscript(app, {
      callId,
      redactedText: 'old text',
      redactionRiskScore: 0.1,
      redactionReasons: [],
    });
    await owner.query(
      `UPDATE clean_transcripts SET hard_deleted_at = now(), soft_deleted_at = NULL WHERE call_id = $1`,
      [callId],
    );
    const before = await owner.query(`SELECT * FROM clean_transcripts WHERE call_id = $1`, [
      callId,
    ]);

    // The retention preflight rejects on BOTH dispositions (would-pass and
    // would-hold) — a known retention conflict must dead-letter, not partially
    // write vault/findings first.
    await expect(makeHandler([happyDetector()])(ctx(callId))).rejects.toThrow(/hard-deleted/);
    await expect(makeHandler([fakeDetector('fake', {})])(ctx(callId))).rejects.toThrow(
      /hard-deleted/,
    );

    // The clean row is byte-for-byte unchanged and NOTHING was written for the call.
    const after = await owner.query(`SELECT * FROM clean_transcripts WHERE call_id = $1`, [callId]);
    expect(after.rows).toEqual(before.rows);
    const vault = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_vault WHERE call_id = $1`,
      [callId],
    );
    expect(Number(vault.rows[0]?.n)).toBe(0);
    expect(await getFindings(app, callId)).toEqual([]);
  });

  it('safe risk hold: only safe reasons past threshold — held redaction_failed WITH a clean row', async () => {
    const callId = 'test-rd-safehold';
    await seedProcessing(callId);
    const noisy = fakeDetector('fake', {
      detections: [
        { ...NAME_SPAN, entityType: 'name', detector: 'ner', confidence: 0.99 },
        { ...PHONE_SPAN, entityType: 'phone', detector: 'regex' },
      ],
      riskSignals: [{ reason: 'ner_low_confidence' }, { reason: 'deny_list_hit' }],
    });
    // Threshold 0.25: safe reasons sum to 0.25 => hold, but outputSafe stays true.
    const result = await makeHandler([noisy], { REDACTION_RISK_THRESHOLD: 0.25 })(ctx(callId));
    expect(result).toMatchObject({
      action: 'hold',
      reason: 'redaction_failed',
      errorCode: 'REDACTION_LOW_CONFIDENCE',
    });
    const clean = await getCleanTranscript(app, callId);
    expect(clean?.redacted_text).toContain('[NAME_1]');
    expect(clean?.redaction_reasons).toEqual(
      expect.arrayContaining(['ner_low_confidence', 'deny_list_hit']),
    );
    expect(await alertCount()).toBe(1);
  });

  it.each([
    'ner_offset_alignment_failed',
    'transcript_chunking_truncated',
    'address_like_ambiguous',
    'short_transcript',
  ] as const)(
    'unsafe risk hold (%s): held redaction_failed with NO active clean row',
    async (reason) => {
      const callId = `test-rd-unsafe-${reason.slice(0, 12)}`;
      await seedProcessing(callId);
      const unsafe = fakeDetector('fake', {
        detections: [
          { ...NAME_SPAN, entityType: 'name', detector: 'ner', confidence: 0.99 },
          { ...PHONE_SPAN, entityType: 'phone', detector: 'regex' },
        ],
        riskSignals: [{ reason }],
      });
      // Threshold 0 makes every non-zero score hold; forced reasons hold regardless.
      const result = await makeHandler([unsafe], { REDACTION_RISK_THRESHOLD: 0 })(ctx(callId));
      expect(result).toMatchObject({ action: 'hold', reason: 'redaction_failed' });
      expect(await getCleanTranscript(app, callId)).toBeUndefined();
    },
  );

  it('forced hold wins even with the threshold at 1', async () => {
    const callId = 'test-rd-forced';
    await seedProcessing(callId);
    const failedAlign = fakeDetector('fake', {
      detections: [
        { ...NAME_SPAN, entityType: 'name', detector: 'ner', confidence: 0.99 },
        { ...PHONE_SPAN, entityType: 'phone', detector: 'regex' },
      ],
      riskSignals: [{ reason: 'ner_offset_alignment_failed' }],
    });
    const result = await makeHandler([failedAlign], { REDACTION_RISK_THRESHOLD: 1 })(ctx(callId));
    expect(result).toMatchObject({ action: 'hold', reason: 'redaction_failed' });
  });

  it('alerts: repeat holds dedupe onto one active alert', async () => {
    const callId = 'test-rd-alertdedupe';
    await seedProcessing(callId, 'contact me at john＠example.com please');
    const handler = makeHandler([fakeDetector('fake', {})]);
    await handler(ctx(callId));
    await handler(ctx(callId));
    expect(await alertCount()).toBe(1);
  });

  it('idempotency: rerunning yields the same tokens, one active finding set, one clean row, stable vault', async () => {
    const callId = 'test-rd-idem';
    await seedProcessing(callId);
    const handler = makeHandler([happyDetector()]);
    await handler(ctx(callId));
    const firstClean = await getCleanTranscript(app, callId);
    await handler(ctx(callId));
    const secondClean = await getCleanTranscript(app, callId);

    expect(secondClean?.redacted_text).toBe(firstClean?.redacted_text);
    const findings = await getFindings(app, callId);
    expect(findings).toHaveLength(3); // active set only — the replace soft-deleted the old one

    const vaultRows = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_vault WHERE call_id = $1`,
      [callId],
    );
    expect(Number(vaultRows.rows[0]?.n)).toBe(2);

    const runner = createRestrictedRunner(app);
    const name = await getToken(runner, keyProvider, { callId, token: '[NAME_1]' });
    expect(name?.toString('utf8')).toBe('John Smith');
  });

  it('negative: after a hold, re-running the pipeline never invokes classify', async () => {
    const callId = 'test-rd-neg';
    await seedProcessing(callId, 'contact me at john＠example.com please');
    const { logger } = collectingLogger();
    const classifySpy = vi.fn(() => Promise.resolve({ action: 'continue' as const }));
    const handlers: StageHandlers = {
      ...defaultStageHandlers,
      redact: makeHandler([fakeDetector('fake', {})]),
      classify: classifySpy,
    };

    await runPipeline(app, callId, logger, handlers);
    const state = await getCallState(app, callId);
    expect(state?.status).toBe('held');

    // One open review row with an SLA.
    const review = await owner.query<{ held_reason: string; sla_due_at: Date | null }>(
      `SELECT held_reason, sla_due_at FROM review_queue WHERE call_id = $1 AND status = 'open'`,
      [callId],
    );
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0]?.held_reason).toBe('residual_pii_detected');
    expect(review.rows[0]?.sla_due_at).toBeInstanceOf(Date);

    // Re-enqueue: the held terminal guard stops the pipeline before classify.
    await runPipeline(app, callId, logger, handlers);
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('missing transcript at redact holds missing_transcript', async () => {
    const callId = 'test-rd-notranscript';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'redact',
      status: 'processing',
    });
    const result = await makeHandler([happyDetector()])(ctx(callId));
    expect(result).toMatchObject({
      action: 'hold',
      reason: 'missing_transcript',
      errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
    });
  });

  it('hold detail and all log lines pass the no-content-fields guard and contain no PII', async () => {
    const callId = 'test-rd-logs';
    await seedProcessing(callId, 'contact me at john＠example.com please');
    const { lines, logger } = collectingLogger();
    const result = await run(makeHandler([fakeDetector('fake', {})]), ctx(callId, logger));

    expect(result.action).toBe('hold');
    if (result.action === 'hold' && result.detail) {
      expect(() => assertNoContentFields(result.detail)).not.toThrow();
      expect(JSON.stringify(result.detail)).not.toContain('john');
    }
    const joined = lines.join('');
    expect(joined).not.toContain('john');
    expect(joined).not.toContain('example.com');
  });

  it('the handler factory fails fast on a missing hash key', () => {
    expect(() =>
      createRedactionHandler({
        keyProvider,
        config: makeTestConfig(),
        detectors: [happyDetector()],
        denyTerms: [],
      }),
    ).toThrow(ConfigError);
  });
});
