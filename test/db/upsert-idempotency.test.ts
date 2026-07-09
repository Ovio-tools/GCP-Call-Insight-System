import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { SENTIMENTS, SERVICE_CATEGORIES } from '../../src/db/enums.js';
import { repositories, restricted } from '../../src/db/index.js';
import type { RestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { hasRawTestDb, hasTestDb, makePool, makeRawPool, migrate, migrateRaw } from './_pg.js';
import {
  cleanupCalls,
  cleanupRawCalls,
  makeAppPool,
  makeRawRestrictedRunner,
  seedKeyVersion,
} from './_dal.js';

const PATTERN = 'test-idem-%';

/** Re-running any pipeline-result write updates in place, never duplicates. */
describe.skipIf(!hasTestDb)('upsert idempotency', () => {
  let owner!: Pool;
  let app!: Pool;
  // token_vault lives in DB-B (ADR 0008 Move 2) — reached via the raw-store restricted runner.
  let rawOwner: Pool | undefined;
  let rawRunnerPool: Pool | undefined;
  let rawRunner: RestrictedRunner | undefined;
  const keyProvider = new LocalKeyProvider({
    masterKey: Buffer.alloc(DEK_BYTES, 0x07),
    activeKeyVersion: 1,
  });
  const runner = () => restricted.createRestrictedRunner(app);

  async function rawCountActive(table: string, callId: string): Promise<number> {
    const res = await rawOwner!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(res.rows[0]?.n);
  }

  async function seedCall(callId: string): Promise<void> {
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'processing',
    });
  }

  async function countActive(table: string, callId: string): Promise<number> {
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
      [callId],
    );
    return Number(res.rows[0]?.n);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    if (hasRawTestDb) {
      await migrateRaw('up');
      rawOwner = makeRawPool();
      ({ pool: rawRunnerPool, runner: rawRunner } = makeRawRestrictedRunner());
    }
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    if (rawOwner) await cleanupRawCalls(rawOwner, PATTERN);
    await owner.end();
    await app.end();
    if (rawOwner) await rawOwner.end();
    if (rawRunnerPool) await rawRunnerPool.end();
  });

  it('call_state upsert keeps one row and reflects the latest write', async () => {
    const callId = 'test-idem-cs';
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'fetch',
      status: 'processing',
    });
    const second = await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'classify',
      status: 'processing',
    });
    expect(second.current_stage).toBe('classify');
    expect(await countActive('call_state', callId)).toBe(1);
  });

  it('clean_transcripts upsert keeps one row', async () => {
    const callId = 'test-idem-clean';
    await seedCall(callId);
    await repositories.cleanTranscripts.upsertCleanTranscript(app, {
      callId,
      redactedText: 'first',
      redactionRiskScore: 0.1,
    });
    const second = await repositories.cleanTranscripts.upsertCleanTranscript(app, {
      callId,
      redactedText: 'second',
      redactionRiskScore: 0.42,
    });
    expect(second.redacted_text).toBe('second');
    expect(second.redaction_risk_score).toBe('0.4200');
    expect(await countActive('clean_transcripts', callId)).toBe(1);
  });

  it('structured_knowledge upsert keeps one row', async () => {
    const callId = 'test-idem-sk';
    await seedCall(callId);
    const base = {
      callId,
      callIntent: 'new_booking' as const,
      serviceCategory: 'water_heater' as const,
      urgency: 'routine' as const,
      sentiment: 'neutral' as const,
      schemaVersion: 1,
      promptVersion: 'v1',
      modelId: 'claude-haiku-4-5',
    };
    await repositories.structuredKnowledge.upsertStructuredKnowledge(app, base);
    const second = await repositories.structuredKnowledge.upsertStructuredKnowledge(app, {
      ...base,
      urgency: 'emergency',
    });
    expect(second.urgency).toBe('emergency');
    expect(await countActive('structured_knowledge', callId)).toBe(1);
  });

  it('structured_knowledge CHECKs reject uncontrolled category/sentiment at the SQL layer', async () => {
    const callId = 'test-idem-sk-chk';
    await seedCall(callId);
    const insertRaw = (serviceCategory: string, sentiment: string) =>
      owner.query(
        `INSERT INTO structured_knowledge (
           call_id, call_intent, service_category, urgency, sentiment,
           schema_version, prompt_version, model_id)
         VALUES ($1, 'new_booking', $2, 'routine', $3, 1, 'v1', 'm1')`,
        [callId, serviceCategory, sentiment],
      );
    await expect(insertRaw('hvac', 'neutral')).rejects.toThrow(
      /structured_knowledge_service_category_chk/,
    );
    await expect(insertRaw('water_heater', 'ecstatic')).rejects.toThrow(
      /structured_knowledge_sentiment_chk/,
    );
  });

  // Positive TS/DB parity loops (convention: call-state-drop.test.ts "stores every
  // DROP_REASONS value"): every value the TS tuples allow must also pass the SQL
  // CHECKs, so the two vocabularies cannot drift apart silently in either direction.
  function skBase(callId: string) {
    return {
      callId,
      callIntent: 'new_booking' as const,
      serviceCategory: 'water_heater' as const,
      urgency: 'routine' as const,
      sentiment: 'neutral' as const,
      schemaVersion: 1,
      promptVersion: 'v1',
      modelId: 'm1',
    };
  }

  it('structured_knowledge accepts every SERVICE_CATEGORIES value (TS/DB parity)', async () => {
    for (const category of SERVICE_CATEGORIES) {
      const callId = `test-idem-sk-parity-cat-${category}`;
      await seedCall(callId);
      const row = await repositories.structuredKnowledge.upsertStructuredKnowledge(app, {
        ...skBase(callId),
        serviceCategory: category,
      });
      expect(row.service_category).toBe(category);
    }
  });

  it('structured_knowledge accepts every SENTIMENTS value (TS/DB parity)', async () => {
    for (const sentiment of SENTIMENTS) {
      const callId = `test-idem-sk-parity-sent-${sentiment}`;
      await seedCall(callId);
      const row = await repositories.structuredKnowledge.upsertStructuredKnowledge(app, {
        ...skBase(callId),
        sentiment,
      });
      expect(row.sentiment).toBe(sentiment);
    }
  });

  it.skipIf(!hasRawTestDb)(
    'token_vault upsert on (call_id, token) keeps one row and re-encrypts',
    async () => {
      const callId = 'test-idem-vault';
      // DB-B token_vault has no cross-DB FK to call_state — no seedCall needed.
      await restricted.tokenVault.putToken(rawRunner!, keyProvider, {
        callId,
        token: '[PHONE_1]',
        plaintext: Buffer.from('111', 'utf8'),
      });
      await restricted.tokenVault.putToken(rawRunner!, keyProvider, {
        callId,
        token: '[PHONE_1]',
        plaintext: Buffer.from('222', 'utf8'),
      });
      const value = await restricted.tokenVault.getToken(rawRunner!, keyProvider, {
        callId,
        token: '[PHONE_1]',
      });
      expect(value?.toString('utf8')).toBe('222');
      expect(await rawCountActive('token_vault', callId)).toBe(1);
    },
  );

  it('daily_cost_usage upsert accumulates on the day key', async () => {
    const day = '2026-07-01';
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [day]);
    await repositories.dailyCostUsage.upsertDailyCost(app, {
      day,
      inputTokens: 100,
      outputTokens: 20,
      estimatedCost: 0.01,
    });
    const second = await repositories.dailyCostUsage.upsertDailyCost(app, {
      day,
      inputTokens: 50,
      outputTokens: 5,
      estimatedCost: 0.02,
    });
    expect(second.input_tokens).toBe('150');
    expect(second.output_tokens).toBe('25');
    expect(second.estimated_cost).toBe('0.030000');
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM daily_cost_usage WHERE day = $1`,
      [day],
    );
    expect(res.rows[0]?.n).toBe('1');
    await owner.query(`DELETE FROM daily_cost_usage WHERE day = $1`, [day]);
  });

  it('alert_events dedups an unacknowledged incident', async () => {
    const dedupKey = 'test-idem-alert-key';
    await owner.query(`DELETE FROM alert_events WHERE dedup_key = $1`, [dedupKey]);
    const first = await repositories.alertEvents.recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'high',
      dedupKey,
    });
    const second = await repositories.alertEvents.recordAlert(app, {
      errorCode: 'DATABASE_UNAVAILABLE',
      rootCauseCategory: 'DATABASE_UNAVAILABLE',
      severity: 'high',
      dedupKey,
    });
    expect(second.id).toBe(first.id);
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_events WHERE dedup_key = $1`,
      [dedupKey],
    );
    expect(res.rows[0]?.n).toBe('1');
    await owner.query(`DELETE FROM alert_events WHERE dedup_key = $1`, [dedupKey]);
  });

  it('redaction_findings set-replacement: 2 active, soft-deleted history retained', async () => {
    const callId = 'test-idem-find';
    await seedCall(callId);
    await repositories.redactionFindings.replaceFindings(app, callId, [
      { entityType: 'phone' },
      { entityType: 'name' },
      { entityType: 'email' },
    ]);
    await repositories.redactionFindings.replaceFindings(app, callId, [
      { entityType: 'phone' },
      { entityType: 'address' },
    ]);
    const active = await repositories.redactionFindings.getFindings(app, callId);
    expect(active).toHaveLength(2);
    expect(await countActive('redaction_findings', callId)).toBe(5); // 3 soft-deleted + 2 active
    const soft = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM redaction_findings
        WHERE call_id = $1 AND soft_deleted_at IS NOT NULL`,
      [callId],
    );
    expect(soft.rows[0]?.n).toBe('3');
  });

  it('match_keys set-replacement: 1 active, previous digest soft-deleted', async () => {
    const callId = 'test-idem-mk';
    await seedCall(callId);
    await restricted.matchKeys.putMatchKeys(runner(), {
      callId,
      phoneHmac: Buffer.from('aaaa', 'hex'),
      keyVersion: 1,
    });
    await restricted.matchKeys.putMatchKeys(runner(), {
      callId,
      phoneHmac: Buffer.from('bbbb', 'hex'),
      keyVersion: 1,
    });
    const active = await restricted.matchKeys.getMatchKeys(runner(), callId);
    expect(active).toHaveLength(1);
    expect(active[0]?.phone_hmac?.toString('hex')).toBe('bbbb');
    expect(await countActive('match_keys', callId)).toBe(2); // 1 soft-deleted + 1 active
  });
});
