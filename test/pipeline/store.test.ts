import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { storeHandler } from '../../src/pipeline/store.js';
import { createMarkRetentionEligibleHandler } from '../../src/pipeline/mark-retention-eligible.js';
import { runPipeline } from '../_run-pipeline.js';
import {
  defaultStageHandlers,
  type PipelineStage,
  type StageContext,
  type StageHandlers,
} from '../../src/pipeline/stages.js';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { getCallState, upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import {
  markPiiScanPassed,
  upsertExtractionCandidate,
} from '../../src/db/repositories/extraction-candidates-repo.js';
import type { ExtractionCandidateInsert } from '../../src/db/schemas/extraction-candidates.js';
import { putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { putToken } from '../../src/db/restricted/token-vault-repo.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from '../db/_pg.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawAppPool,
  seedKeyVersion,
} from '../db/_dal.js';

/**
 * Task 5.3 — the `store` stage copies the verified extraction candidate into the durable
 * `structured_knowledge` store (idempotent upsert on call_id), and the final
 * `mark-retention-eligible` stage stamps the raw transcript + vault (and the now-redundant
 * staging candidate) retention-eligible. Nothing is ever deleted here — deletion is the
 * scheduled retention job's job. The call reaches `completed` only after a successful store.
 */

const PATTERN = 'test-store-%';

const keyProvider = new LocalKeyProvider({
  masterKey: Buffer.alloc(DEK_BYTES, 0x09),
  activeKeyVersion: 1,
});

/** A full valid candidate insert; `overrides` vary the payload between runs. */
function baseCandidate(
  callId: string,
  overrides: Partial<ExtractionCandidateInsert> = {},
): ExtractionCandidateInsert {
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
    modelId: 'm1',
    ...overrides,
  };
}

describe.skipIf(!hasTestDb || !hasRawTestDb)('store + mark-retention-eligible (Task 5.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  // DB-B (raw store): raw_transcripts + token_vault now live only here.
  let rawOwner!: Pool;
  let rawApp!: Pool;
  const silent = createRootLogger({ level: 'silent' });

  /** The two live 5.3 stages over stubs; earlier stages never run (we seed at `store`). */
  let handlers: StageHandlers;

  const ctx = (callId: string, stage: PipelineStage = 'store'): StageContext => ({
    callId,
    stage,
    logger: silent,
    pool: app,
  });

  /** Seed a passed candidate for a call (upsert resets to pending, then latch passed). */
  const seedPassedCandidate = async (
    callId: string,
    overrides: Partial<ExtractionCandidateInsert> = {},
  ): Promise<void> => {
    await upsertExtractionCandidate(app, baseCandidate(callId, overrides));
    await markPiiScanPassed(app, callId);
  };

  /** Seed call_state@store + a passed candidate + raw transcript + two vault tokens. */
  const seedAtStore = async (callId: string): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    await seedPassedCandidate(callId);
    await putTranscript(rawApp, keyProvider, { callId, transcript: 'Caller: no hot water.' });
    const runner = createRestrictedRunner(rawApp);
    await putToken(runner, keyProvider, {
      callId,
      token: '[NAME_1]',
      plaintext: Buffer.from('Jane Doe', 'utf8'),
    });
    await putToken(runner, keyProvider, {
      callId,
      token: '[PHONE_1]',
      plaintext: Buffer.from('5551234567', 'utf8'),
    });
  };

  const skRows = async (callId: string): Promise<Record<string, unknown>[]> => {
    const r = await owner.query(`SELECT * FROM structured_knowledge WHERE call_id = $1`, [callId]);
    return r.rows as Record<string, unknown>[];
  };
  const one = async (
    table: string,
    callId: string,
    from?: Pool,
  ): Promise<Record<string, unknown> | undefined> => {
    const r = await (from ?? owner).query(`SELECT * FROM ${table} WHERE call_id = $1`, [callId]);
    return r.rows[0] as Record<string, unknown> | undefined;
  };
  const rowCount = async (table: string, callId: string, from?: Pool): Promise<number> => {
    const r = await (from ?? owner).query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(r.rows[0]?.n);
  };

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
      store: storeHandler,
      'mark-retention-eligible': createMarkRetentionEligibleHandler({ rawPool: rawApp }),
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

  // ---- store stage: the durable write --------------------------------------------------

  it('store writes the candidate to structured_knowledge and continues', async () => {
    const callId = 'test-store-write';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    await seedPassedCandidate(callId);

    const res = await storeHandler(ctx(callId));

    expect(res).toEqual({
      action: 'continue',
      detail: { schema_version: 1, prompt_version: 'extract-v1' },
    });
    const rows = await skRows(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_intent: 'new_booking',
      service_category: 'water_heater',
      problem_statement: 'no hot water',
      customer_language: ['my water heater is leaking'],
      schema_version: 1,
      prompt_version: 'extract-v1',
      model_id: 'm1',
    });
    // The staging candidate is now retired (retention-eligible) but NOT deleted.
    const cand = await one('extraction_candidates', callId);
    expect(cand?.retention_eligible_at).not.toBeNull();
    expect(cand?.soft_deleted_at).toBeNull();
    expect(cand?.hard_deleted_at).toBeNull();
  });

  it('storing the same call twice yields ONE record reflecting the latest run', async () => {
    const callId = 'test-store-twice';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });

    await seedPassedCandidate(callId, {
      serviceCategory: 'water_heater',
      problemStatement: 'no hot water',
    });
    await storeHandler(ctx(callId));

    // Re-extract with different content (upsert resets the pii latch → re-pass), store again.
    await seedPassedCandidate(callId, {
      serviceCategory: 'drain_blockage',
      problemStatement: 'kitchen sink backing up',
      urgency: 'urgent',
    });
    await storeHandler(ctx(callId));

    const rows = await skRows(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service_category: 'drain_blockage',
      problem_statement: 'kitchen sink backing up',
      urgency: 'urgent',
    });
  });

  it('store throws (invariant) when no candidate exists, writing nothing', async () => {
    const callId = 'test-store-nocand';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });

    await expect(storeHandler(ctx(callId))).rejects.toThrow(/missing at store/);
    expect(await rowCount('structured_knowledge', callId)).toBe(0);
  });

  it('store refuses a candidate that has not passed the verbatim PII scan', async () => {
    const callId = 'test-store-notpassed';
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    // Upsert leaves pii_scan_status='pending' — do NOT mark passed.
    await upsertExtractionCandidate(app, baseCandidate(callId));

    await expect(storeHandler(ctx(callId))).rejects.toThrow(/pii_scan_status 'pending'/);
    expect(await rowCount('structured_knowledge', callId)).toBe(0);
  });

  // ---- full pipeline: store → mark-retention-eligible → completed -----------------------

  it('runs to completed, stamps raw + vault + candidate retention-eligible, deletes nothing', async () => {
    const callId = 'test-store-complete';
    await seedAtStore(callId);

    await runPipeline(app, callId, silent, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('completed');
    expect(state?.current_stage).toBe('mark-retention-eligible');

    // Exactly one durable record.
    expect(await rowCount('structured_knowledge', callId)).toBe(1);

    // Raw transcript + candidate stamped, not deleted.
    const raw = await one('raw_transcripts', callId, rawOwner);
    expect(raw?.retention_eligible_at).not.toBeNull();
    expect(raw?.soft_deleted_at).toBeNull();
    expect(raw?.hard_deleted_at).toBeNull();
    const cand = await one('extraction_candidates', callId);
    expect(cand?.retention_eligible_at).not.toBeNull();

    // BOTH vault rows stamped; none deleted.
    expect(await rowCount('token_vault', callId, rawOwner)).toBe(2);
    const unstampedVault = await rawOwner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_vault
        WHERE call_id = $1 AND retention_eligible_at IS NULL`,
      [callId],
    );
    expect(Number(unstampedVault.rows[0]?.n)).toBe(0);
    const deletedVault = await rawOwner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_vault
        WHERE call_id = $1 AND (soft_deleted_at IS NOT NULL OR hard_deleted_at IS NOT NULL)`,
      [callId],
    );
    expect(Number(deletedVault.rows[0]?.n)).toBe(0);
  });

  it('call_state reaches completed ONLY after a successful store', async () => {
    const callId = 'test-store-gated';
    // No candidate yet → store fails; the runner wraps the throw and never completes.
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
    await expect(runPipeline(app, callId, silent, handlers)).rejects.toThrow();

    let state = await getCallState(app, callId);
    expect(state?.status).toBe('processing');
    expect(state?.current_stage).toBe('store');
    expect(await rowCount('structured_knowledge', callId)).toBe(0);

    // Supply the inputs; now the same call completes.
    await seedPassedCandidate(callId);
    await putTranscript(rawApp, keyProvider, { callId, transcript: 'Caller: no hot water.' });
    await runPipeline(app, callId, silent, handlers);
    state = await getCallState(app, callId);
    expect(state?.status).toBe('completed');
    expect(await rowCount('structured_knowledge', callId)).toBe(1);
  });

  // ---- mark-retention-eligible: idempotent + monotonic + never deletes -----------------

  it('re-running mark-retention-eligible does not reset the stamp or delete anything', async () => {
    const callId = 'test-store-idem';
    await seedAtStore(callId);
    await runPipeline(app, callId, silent, handlers);

    const rawBefore = (await one('raw_transcripts', callId, rawOwner))
      ?.retention_eligible_at as Date;
    expect(rawBefore).not.toBeNull();

    // Re-run the final stage handler directly (the runner would no-op a completed call).
    await createMarkRetentionEligibleHandler({ rawPool: rawApp })(
      ctx(callId, 'mark-retention-eligible'),
    );

    const rawAfter = (await one('raw_transcripts', callId, rawOwner))
      ?.retention_eligible_at as Date;
    expect(new Date(rawAfter).getTime()).toBe(new Date(rawBefore).getTime());
    expect(await rowCount('raw_transcripts', callId, rawOwner)).toBe(1);
    expect(await rowCount('token_vault', callId, rawOwner)).toBe(2);
  });

  it('never stamps a hard-deleted (retention-final) raw transcript', async () => {
    const callId = 'test-store-harddel';
    await seedAtStore(callId);
    // Simulate retention having crypto-shredded the raw transcript already.
    await rawOwner.query(
      `UPDATE raw_transcripts SET hard_deleted_at = now(), retention_eligible_at = NULL
        WHERE call_id = $1`,
      [callId],
    );

    await createMarkRetentionEligibleHandler({ rawPool: rawApp })(
      ctx(callId, 'mark-retention-eligible'),
    );

    const raw = await one('raw_transcripts', callId, rawOwner);
    expect(raw?.retention_eligible_at).toBeNull();
    expect(raw?.hard_deleted_at).not.toBeNull();
  });
});
