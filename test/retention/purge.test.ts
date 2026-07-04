import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { runPurge } from '../../src/retention/purge.js';
import { createAppPool } from '../../src/db/index.js';
import type { Config } from '../../src/config/schema.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate, TEST_DATABASE_URL } from '../db/_pg.js';
import { cleanupCalls, seedKeyVersion } from '../db/_dal.js';

const PATTERN = 'test-purge-%';
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

/** Windows chosen for simple arithmetic: soft 10 / hard 40 (grace 30) for RAW/WEBHOOK/MATCH,
 * CLEAN windowed 30/365, EXTRACT 10/40. Cap 72h. */
function purgeConfig(over: Partial<Config> = {}): Config {
  return makeTestConfig({
    RETENTION_RAW_SOFT_DELETE_DAYS: 10,
    RETENTION_RAW_HARD_DELETE_DAYS: 40,
    RETENTION_WEBHOOK_SOFT_DELETE_DAYS: 10,
    RETENTION_WEBHOOK_HARD_DELETE_DAYS: 40,
    RETENTION_MATCH_KEYS_SOFT_DELETE_DAYS: 10,
    RETENTION_MATCH_KEYS_HARD_DELETE_DAYS: 40,
    RETENTION_CLEAN_SOFT_DELETE_DAYS: 30,
    RETENTION_CLEAN_HARD_DELETE_DAYS: 365,
    RETENTION_EXTRACT_SOFT_DELETE_DAYS: 10,
    RETENTION_EXTRACT_HARD_DELETE_DAYS: 40,
    REVIEW_HELD_RAW_RETENTION_CAP_HOURS: 72,
    RETENTION_PURGE_BATCH_SIZE: 1000,
    ...over,
  });
}

describe.skipIf(!hasTestDb)('runPurge (Task 8.1)', () => {
  let owner!: Pool;
  let purge!: Pool;
  const logger = makeCapturingLogger().logger;

  const run = (config = purgeConfig(), now = NOW) =>
    runPurge({ pool: purge, config, logger, now });

  // --- seeders (owner, explicit timestamps) ---
  async function ensureCall(callId: string, status = 'processing'): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'store', $2) ON CONFLICT (call_id) DO NOTHING`,
      [callId, status],
    );
  }
  async function seedRaw(callId: string, eligible: Date | null, soft: Date | null = null): Promise<void> {
    await ensureCall(callId);
    await owner.query(
      `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, retention_eligible_at, soft_deleted_at)
       VALUES ($1, $2, 1, $3, $4)`,
      [callId, Buffer.from('cipher'), eligible, soft],
    );
  }
  async function seedVault(callId: string, eligible: Date | null, soft: Date | null = null): Promise<void> {
    await owner.query(
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version, retention_eligible_at, soft_deleted_at)
       VALUES ($1, '[NAME_1]', $2, 1, $3, $4)`,
      [callId, Buffer.from('cipher'), eligible, soft],
    );
  }
  async function seedClean(callId: string, eligible: Date | null, soft: Date | null = null): Promise<void> {
    await ensureCall(callId);
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, retention_eligible_at, soft_deleted_at)
       VALUES ($1, 'redacted here', 0.1, $2, $3)`,
      [callId, eligible, soft],
    );
  }
  async function seedFinding(callId: string, eligible: Date | null, soft: Date | null = null): Promise<void> {
    await ensureCall(callId);
    await owner.query(
      `INSERT INTO redaction_findings (call_id, entity_type, token_ref, value_hash, residual_scan_result, retention_eligible_at, soft_deleted_at)
       VALUES ($1, 'NAME', '[NAME_1]', $2, '{"x":1}'::jsonb, $3, $4)`,
      [callId, Buffer.from('h'), eligible, soft],
    );
  }
  async function seedWebhook(eligible: Date | null, soft: Date | null = null): Promise<string> {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO raw_webhook_events (source, payload, signature_status, retention_eligible_at, soft_deleted_at)
       VALUES ('dialpad', '{"a":1}'::jsonb, 'valid', $1, $2) RETURNING id`,
      [eligible, soft],
    );
    return rows[0]!.id;
  }
  async function seedReview(
    callId: string,
    status: string,
    createdAt: Date,
  ): Promise<string> {
    await ensureCall(callId, 'held');
    const active = status === 'open' || status === 'in_review';
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, created_at)
       VALUES ($1, 'missing_transcript', $2, CASE WHEN $3 THEN now()+interval '1 hour' ELSE NULL END, $4)
       RETURNING id`,
      [callId, status, active, createdAt],
    );
    return rows[0]!.id;
  }

  const col = async (table: string, callId: string, c: string): Promise<unknown> =>
    (await owner.query(`SELECT ${c} AS v FROM ${table} WHERE call_id = $1`, [callId])).rows[0]?.v;
  const rowExists = async (table: string, callId: string): Promise<boolean> =>
    ((await owner.query(`SELECT 1 FROM ${table} WHERE call_id = $1`, [callId])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    purge = createAppPool(TEST_DATABASE_URL as string, 'purge_role');
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.query(`DELETE FROM raw_webhook_events WHERE source = 'dialpad'`);
  });
  afterAll(async () => {
    await owner.end();
    await purge.end();
  });

  it('leaves rows inside their soft window untouched', async () => {
    await seedRaw('test-purge-fresh', daysAgo(3)); // < soft 10
    await run();
    expect(await col('raw_transcripts', 'test-purge-fresh', 'soft_deleted_at')).toBeNull();
    expect(await col('raw_transcripts', 'test-purge-fresh', 'hard_deleted_at')).toBeNull();
  });

  it('soft precedes hard across runs — a never-soft row is only soft-deleted this run', async () => {
    await seedRaw('test-purge-grace', daysAgo(50)); // past hard(40), but never soft-deleted
    await seedVault('test-purge-grace', daysAgo(50));
    await run(); // run 1
    expect(await col('raw_transcripts', 'test-purge-grace', 'soft_deleted_at')).not.toBeNull();
    // NOT hard-deleted in the same run — grace not yet elapsed.
    expect(await col('raw_transcripts', 'test-purge-grace', 'hard_deleted_at')).toBeNull();

    // A later run, after the grace gap (30d) elapses relative to the soft stamp.
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    await run(purgeConfig(), later);
    expect(await col('raw_transcripts', 'test-purge-grace', 'hard_deleted_at')).not.toBeNull();
    expect(await col('token_vault', 'test-purge-grace', 'hard_deleted_at')).not.toBeNull();
  });

  it('hard-delete scrubs raw + vault ciphertext (stamp-and-scrub)', async () => {
    await seedRaw('test-purge-hard', daysAgo(50), daysAgo(35)); // eligible past hard, soft past grace
    await seedVault('test-purge-hard', daysAgo(50), daysAgo(35));
    await run();
    expect(await col('raw_transcripts', 'test-purge-hard', 'hard_deleted_at')).not.toBeNull();
    const rawCipher = (await col('raw_transcripts', 'test-purge-hard', 'ciphertext')) as Buffer;
    expect(rawCipher.length).toBe(0); // scrubbed to ''
    const vaultCipher = (await col('token_vault', 'test-purge-hard', 'ciphertext')) as Buffer;
    expect(vaultCipher.length).toBe(0);
  });

  it('never touches structured_knowledge or call_state', async () => {
    await ensureCall('test-purge-durable');
    await owner.query(
      `INSERT INTO structured_knowledge
         (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id)
       VALUES ($1, 'new_booking', 'water_heater', 'routine', 'neutral', 1, 'v1', 'm') ON CONFLICT DO NOTHING`,
      ['test-purge-durable'],
    );
    await run();
    expect(await rowExists('structured_knowledge', 'test-purge-durable')).toBe(true);
    expect(await rowExists('call_state', 'test-purge-durable')).toBe(true);
  });

  it('RAW is parent-driven: raw drives vault soft-delete even when the vault stamp lags', async () => {
    // parent past soft, child stamp only 1 second past-eligible (not independently soft-eligible
    // if judged alone at a tighter window) — parent-driven soft-deletes BOTH.
    await seedRaw('test-purge-skew', daysAgo(20));
    await seedVault('test-purge-skew', new Date(NOW.getTime() - 1000)); // ~now
    await run();
    expect(await col('raw_transcripts', 'test-purge-skew', 'soft_deleted_at')).not.toBeNull();
    expect(await col('token_vault', 'test-purge-skew', 'soft_deleted_at')).not.toBeNull();
  });

  it('orphan vault (no raw row) still purges on its own window', async () => {
    await ensureCall('test-purge-orphan-vault');
    await seedVault('test-purge-orphan-vault', daysAgo(20)); // no raw row
    await run();
    expect(await col('token_vault', 'test-purge-orphan-vault', 'soft_deleted_at')).not.toBeNull();
  });

  it('CLEAN drives findings; findings purge with clean atomically', async () => {
    await seedClean('test-purge-cf', daysAgo(40)); // past CLEAN soft 30
    await seedFinding('test-purge-cf', new Date(NOW.getTime() - 1000)); // lagging stamp
    await run();
    expect(await col('clean_transcripts', 'test-purge-cf', 'soft_deleted_at')).not.toBeNull();
    expect(await col('redaction_findings', 'test-purge-cf', 'soft_deleted_at')).not.toBeNull();
  });

  it('webhook and match purge on their own windows', async () => {
    const whId = await seedWebhook(daysAgo(20));
    await ensureCall('test-purge-match');
    await owner.query(
      `INSERT INTO match_keys (call_id, phone_hmac, name_hmac, key_version, retention_eligible_at)
       VALUES ($1, 'p', 'n', 1, $2)`,
      ['test-purge-match', daysAgo(20)],
    );
    await run();
    expect(
      (await owner.query(`SELECT soft_deleted_at FROM raw_webhook_events WHERE id = $1`, [whId]))
        .rows[0]?.soft_deleted_at,
    ).not.toBeNull();
    expect(await col('match_keys', 'test-purge-match', 'soft_deleted_at')).not.toBeNull();
  });

  it('extraction_candidates purges and every content field is scrubbed on hard-delete', async () => {
    await ensureCall('test-purge-extract');
    await owner.query(
      `INSERT INTO extraction_candidates
        (call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
         location_in_home, access_or_scheduling_notes, prior_attempts, urgency, concerns,
         sentiment, acquisition_source, competitor_mentions, pii_scan_status, schema_version,
         prompt_version, model_id, retention_eligible_at, soft_deleted_at)
       VALUES ($1, 'new_booking', 'water_heater', 'leak', '["drip"]'::jsonb, '["help"]'::jsonb,
         'kitchen', 'gate code 1234', 'tried tape', 'urgent', '["cost"]'::jsonb,
         'negative', 'google', '["acme"]'::jsonb, 'passed', 1, 'v1', 'm',
         $2, $3)`,
      ['test-purge-extract', daysAgo(50), daysAgo(45)],
    );
    await run();
    expect(await col('extraction_candidates', 'test-purge-extract', 'hard_deleted_at')).not.toBeNull();
    for (const c of [
      'problem_statement',
      'location_in_home',
      'access_or_scheduling_notes',
      'prior_attempts',
      'acquisition_source',
      'pii_scan_counts',
    ]) {
      expect(await col('extraction_candidates', 'test-purge-extract', c), c).toBeNull();
    }
    for (const c of ['symptoms', 'customer_language', 'concerns', 'competitor_mentions']) {
      expect(await col('extraction_candidates', 'test-purge-extract', c), c).toEqual([]);
    }
    // Metadata kept for tombstone validity.
    expect(await col('extraction_candidates', 'test-purge-extract', 'call_intent')).toBe('new_booking');
  });

  it('held call past the cap: raw/vault physically gone + raw_purged_at stamped, clean + queue survive', async () => {
    const id = await seedReview('test-purge-cap', 'unresolvable', daysAgo(5)); // > 72h
    await seedRaw('test-purge-cap', null); // held raw is not normally-eligible
    await seedVault('test-purge-cap', null);
    await seedClean('test-purge-cap', daysAgo(1));
    await run();
    expect(await rowExists('raw_transcripts', 'test-purge-cap')).toBe(false);
    expect(await rowExists('token_vault', 'test-purge-cap')).toBe(false);
    expect(await rowExists('clean_transcripts', 'test-purge-cap')).toBe(true);
    expect(
      (await owner.query(`SELECT raw_purged_at FROM review_queue WHERE id = $1`, [id])).rows[0]
        ?.raw_purged_at,
    ).not.toBeNull();
  });

  it('held call before the cap: raw/vault survive (active pre-cap hold)', async () => {
    await seedReview('test-purge-precap', 'open', daysAgo(1)); // < 72h
    await seedRaw('test-purge-precap', daysAgo(50)); // even normally-eligible...
    await seedVault('test-purge-precap', daysAgo(50));
    await run();
    // blocking review protects raw/vault from the normal pass, and the cap hasn't hit.
    expect(await rowExists('raw_transcripts', 'test-purge-precap')).toBe(true);
    expect(await col('raw_transcripts', 'test-purge-precap', 'soft_deleted_at')).toBeNull();
    expect(await rowExists('token_vault', 'test-purge-precap')).toBe(true);
  });

  it('held call that never completes: clean/findings blocked while active, purge once unblocked', async () => {
    // Active review → clean blocked despite being past window.
    await seedReview('test-purge-held-clean', 'open', daysAgo(1));
    await seedClean('test-purge-held-clean', daysAgo(40));
    await seedFinding('test-purge-held-clean', daysAgo(40));
    await run();
    expect(await col('clean_transcripts', 'test-purge-held-clean', 'soft_deleted_at')).toBeNull();

    // Resolve the review → no longer blocking → clean purges.
    await owner.query(
      `UPDATE review_queue SET status = 'resolved', resolved_at = now() WHERE call_id = $1`,
      ['test-purge-held-clean'],
    );
    await run();
    expect(await col('clean_transcripts', 'test-purge-held-clean', 'soft_deleted_at')).not.toBeNull();
  });

  it('dry-run changes nothing and reports per-table + grouped counts', async () => {
    await seedRaw('test-purge-dry', daysAgo(50), daysAgo(45));
    await seedVault('test-purge-dry', daysAgo(50), daysAgo(45));
    const capId = await seedReview('test-purge-dry-cap', 'unresolvable', daysAgo(5));
    await seedRaw('test-purge-dry-cap', null);

    const report = await run(purgeConfig({ RETENTION_DRY_RUN: true }));
    expect(report.dryRun).toBe(true);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.groupCounts.length).toBeGreaterThan(0);
    // Zero mutations.
    expect(await col('raw_transcripts', 'test-purge-dry', 'hard_deleted_at')).toBeNull();
    expect(await rowExists('raw_transcripts', 'test-purge-dry-cap')).toBe(true);
    expect(
      (await owner.query(`SELECT raw_purged_at FROM review_queue WHERE id = $1`, [capId])).rows[0]
        ?.raw_purged_at,
    ).toBeNull();
  });

  it('CLEAN indefinite mode (never/never) never soft- or hard-deletes clean/findings', async () => {
    await seedClean('test-purge-indef', daysAgo(400));
    await seedFinding('test-purge-indef', daysAgo(400));
    await run(
      purgeConfig({
        RETENTION_CLEAN_SOFT_DELETE_DAYS: 'never',
        RETENTION_CLEAN_HARD_DELETE_DAYS: 'never',
      }),
    );
    expect(await col('clean_transcripts', 'test-purge-indef', 'soft_deleted_at')).toBeNull();
    expect(await col('clean_transcripts', 'test-purge-indef', 'hard_deleted_at')).toBeNull();
    expect(await col('redaction_findings', 'test-purge-indef', 'soft_deleted_at')).toBeNull();
  });

  it('soft delete is recoverable within grace (restore = clear soft_deleted_at)', async () => {
    await seedRaw('test-purge-restore', daysAgo(20));
    await run();
    expect(await col('raw_transcripts', 'test-purge-restore', 'soft_deleted_at')).not.toBeNull();
    await owner.query(`UPDATE raw_transcripts SET soft_deleted_at = NULL WHERE call_id = $1`, [
      'test-purge-restore',
    ]);
    const cipher = (await col('raw_transcripts', 'test-purge-restore', 'ciphertext')) as Buffer;
    expect(cipher.length).toBeGreaterThan(0); // data intact
  });

  it('idempotent rerun — second run reports zero new work', async () => {
    await seedRaw('test-purge-idem', daysAgo(50), daysAgo(45));
    await run();
    const second = await run();
    const rawHard = second.actions.find(
      (a) => a.table === 'raw_transcripts' && a.action === 'hard_delete',
    );
    expect(rawHard?.count ?? 0).toBe(0);
  });

  it('coupled hard-delete is atomic: a vault-write failure rolls back the raw scrub, and the lock is released', async () => {
    await seedRaw('test-purge-atomic', daysAgo(50), daysAgo(45));
    await seedVault('test-purge-atomic', daysAgo(50), daysAgo(45));

    // A DEDICATED pool (ended below) so the monkeypatched connection never leaks back into the
    // shared `purge` pool. The token_vault HARD update throws mid-transaction.
    const faultyPool = createAppPool(TEST_DATABASE_URL as string, 'purge_role');
    const faulty = {
      connect: async () => {
        const client = await faultyPool.connect();
        const orig = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (text: unknown, params: unknown) => {
          if (
            typeof text === 'string' &&
            text.includes('UPDATE token_vault') &&
            text.includes('hard_deleted_at')
          ) {
            return Promise.reject(Object.assign(new Error('injected vault failure'), { code: 'XX000' }));
          }
          return (orig as (t: unknown, p: unknown) => unknown)(text, params);
        };
        return client;
      },
    } as unknown as Pool;

    try {
      await expect(
        runPurge({ pool: faulty, config: purgeConfig(), logger, now: NOW }),
      ).rejects.toThrow(/retention purge failed/);
    } finally {
      await faultyPool.end();
    }

    // The raw scrub was rolled back with the failed vault write — raw ciphertext intact.
    const cipher = (await col('raw_transcripts', 'test-purge-atomic', 'ciphertext')) as Buffer;
    expect(cipher.length).toBeGreaterThan(0);
    expect(await col('raw_transcripts', 'test-purge-atomic', 'hard_deleted_at')).toBeNull();

    // The advisory lock was released on the thrown failure: a normal run now proceeds (not skipped).
    const ok = await run();
    expect(ok.skipped).toBeFalsy();
  });

  it('concurrency: a second run cannot acquire the lock and returns skipped without purging', async () => {
    await seedRaw('test-purge-conc', daysAgo(50), daysAgo(45));
    // Hold the advisory lock on a separate session so runPurge cannot acquire it.
    const holder: PoolClient = await purge.connect();
    try {
      // Same key runPurge uses (kept in sync with the module).
      await holder.query('SELECT pg_advisory_lock($1)', [8_100_001]);
      const report = await run();
      expect(report.skipped).toBe(true);
      expect(report.actions).toEqual([]);
      // No purge happened.
      expect(await col('raw_transcripts', 'test-purge-conc', 'hard_deleted_at')).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [8_100_001]).catch(() => undefined);
      holder.release();
    }
    // Once released, a fresh run acquires the lock and works.
    const ok = await run();
    expect(ok.skipped).toBeFalsy();
    expect(await col('raw_transcripts', 'test-purge-conc', 'hard_deleted_at')).not.toBeNull();
  });
});
