import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { RetentionPurgeError, runPurge } from '../../src/retention/purge.js';
import { createAppPool } from '../../src/db/index.js';
import { createRawPurgePool } from '../../src/db/raw-store.js';
import type { Config } from '../../src/config/schema.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';
import {
  hasRawTestDb,
  hasTestDb,
  makePool,
  makeRawPool,
  migrate,
  migrateRaw,
  TEST_DATABASE_URL,
  TEST_RAW_DATABASE_URL,
} from '../db/_pg.js';
import { cleanupCalls, cleanupRawCalls, seedKeyVersion } from '../db/_dal.js';

describe('RetentionPurgeError sanitization', () => {
  it('never leaks the underlying cause text into message or String()', () => {
    const err = new RetentionPurgeError(
      {
        group: 'RAW',
        table: 'raw_transcripts',
        action: 'hard_delete',
        dry_run: false,
        sqlstate: 'XX000',
      },
      new Error('SECRET_TRANSCRIPT_TEXT from a DETAIL clause'),
    );
    expect(err.message).not.toContain('SECRET_TRANSCRIPT_TEXT');
    expect(String(err)).not.toContain('SECRET_TRANSCRIPT_TEXT');
    // The sanitized diagnostic is still present for operators.
    expect(err.message).toContain('raw_transcripts');
    expect(err.message).toContain('hard_delete');
    expect(err.message).toContain('XX000');
  });
});

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

describe.skipIf(!hasTestDb || !hasRawTestDb)('runPurge (Task 8.1 / 8.2d two-pool)', () => {
  let owner!: Pool; // DB-A owner (call_state, review_queue, clean_transcripts, …)
  let rawOwner!: Pool; // DB-B owner (raw_transcripts, token_vault, tombstone)
  let purge!: Pool; // DB-A purge_role
  let rawPurge!: Pool; // DB-B purge_role
  const logger = makeCapturingLogger().logger;

  const run = (config = purgeConfig(), now = NOW) =>
    runPurge({ pool: purge, rawPool: rawPurge, config, logger, now });

  // --- seeders (owner, explicit timestamps) ---
  async function ensureCall(callId: string, status = 'processing'): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'store', $2) ON CONFLICT (call_id) DO NOTHING`,
      [callId, status],
    );
  }
  // raw_transcripts + token_vault live ONLY in DB-B → seed on the DB-B owner pool. Their
  // key_version is a plain column there (no cross-DB FK), so no DB-B key_versions seed is needed.
  async function seedRaw(
    callId: string,
    eligible: Date | null,
    soft: Date | null = null,
  ): Promise<void> {
    await ensureCall(callId);
    await rawOwner.query(
      `INSERT INTO raw_transcripts (call_id, ciphertext, key_version, retention_eligible_at, soft_deleted_at)
       VALUES ($1, $2, 1, $3, $4)`,
      [callId, Buffer.from('cipher'), eligible, soft],
    );
  }
  async function seedVault(
    callId: string,
    eligible: Date | null,
    soft: Date | null = null,
  ): Promise<void> {
    await rawOwner.query(
      `INSERT INTO token_vault (call_id, token, ciphertext, key_version, retention_eligible_at, soft_deleted_at)
       VALUES ($1, '[NAME_1]', $2, 1, $3, $4)`,
      [callId, Buffer.from('cipher'), eligible, soft],
    );
  }
  async function seedClean(
    callId: string,
    eligible: Date | null,
    soft: Date | null = null,
  ): Promise<void> {
    await ensureCall(callId);
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, retention_eligible_at, soft_deleted_at)
       VALUES ($1, 'redacted here', 0.1, $2, $3)`,
      [callId, eligible, soft],
    );
  }
  async function seedFinding(
    callId: string,
    eligible: Date | null,
    soft: Date | null = null,
  ): Promise<void> {
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
  async function seedReview(callId: string, status: string, createdAt: Date): Promise<string> {
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

  // raw_transcripts / token_vault / raw_purge_tombstone live in DB-B; everything else in DB-A.
  const RAW_TABLES = new Set(['raw_transcripts', 'token_vault', 'raw_purge_tombstone']);
  const poolFor = (table: string): Pool => (RAW_TABLES.has(table) ? rawOwner : owner);
  const col = async (table: string, callId: string, c: string): Promise<unknown> =>
    (
      await poolFor(table).query<{ v: unknown }>(
        `SELECT ${c} AS v FROM ${table} WHERE call_id = $1`,
        [callId],
      )
    ).rows[0]?.v;
  const rowExists = async (table: string, callId: string): Promise<boolean> =>
    ((await poolFor(table).query(`SELECT 1 FROM ${table} WHERE call_id = $1`, [callId])).rowCount ??
      0) > 0;

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    owner = makePool();
    rawOwner = makeRawPool();
    purge = createAppPool(TEST_DATABASE_URL as string, 'purge_role');
    rawPurge = createRawPurgePool(TEST_RAW_DATABASE_URL as string);
    await seedKeyVersion(owner);
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
    await cleanupRawCalls(rawOwner, PATTERN);
    await owner.query(`DELETE FROM raw_webhook_events WHERE source = 'dialpad'`);
  });
  afterAll(async () => {
    await owner.end();
    await rawOwner.end();
    await purge.end();
    await rawPurge.end();
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
      (
        await owner.query<{ soft_deleted_at: Date | null }>(
          `SELECT soft_deleted_at FROM raw_webhook_events WHERE id = $1`,
          [whId],
        )
      ).rows[0]?.soft_deleted_at,
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
    expect(
      await col('extraction_candidates', 'test-purge-extract', 'hard_deleted_at'),
    ).not.toBeNull();
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
    expect(await col('extraction_candidates', 'test-purge-extract', 'call_intent')).toBe(
      'new_booking',
    );
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
    // The DB-B-local finality marker the recreate/write guards depend on is present.
    expect(await rowExists('raw_purge_tombstone', 'test-purge-cap')).toBe(true);
    expect(
      (
        await owner.query<{ raw_purged_at: Date | null }>(
          `SELECT raw_purged_at FROM review_queue WHERE id = $1`,
          [id],
        )
      ).rows[0]?.raw_purged_at,
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
    expect(
      await col('clean_transcripts', 'test-purge-held-clean', 'soft_deleted_at'),
    ).not.toBeNull();
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
      (
        await owner.query<{ raw_purged_at: Date | null }>(
          `SELECT raw_purged_at FROM review_queue WHERE id = $1`,
          [capId],
        )
      ).rows[0]?.raw_purged_at,
    ).toBeNull();
  });

  it('dry-run reports parent-driven child rows, matching the real run (not just orphans)', async () => {
    // Vault is eligible ONLY through its parent: its own retention_eligible_at is recent, so an
    // orphan-only count would report token_vault soft=0 even though the real parent-driven run
    // soft-deletes it. Same for findings under clean.
    await seedRaw('test-purge-pdc', daysAgo(20)); // parent past soft(10)
    await seedVault('test-purge-pdc', new Date(NOW.getTime() - 1000)); // own window NOT eligible
    await seedClean('test-purge-pdc2', daysAgo(40)); // parent past CLEAN soft(30)
    await seedFinding('test-purge-pdc2', new Date(NOW.getTime() - 1000));

    const report = await run(purgeConfig({ RETENTION_DRY_RUN: true }));
    const vaultSoft = report.actions.find(
      (a) => a.table === 'token_vault' && a.action === 'soft_delete',
    );
    const findingsSoft = report.actions.find(
      (a) => a.table === 'redaction_findings' && a.action === 'soft_delete',
    );
    expect(vaultSoft?.count).toBe(1);
    expect(findingsSoft?.count).toBe(1);
    // Still zero writes.
    expect(await col('token_vault', 'test-purge-pdc', 'soft_deleted_at')).toBeNull();
    expect(await col('redaction_findings', 'test-purge-pdc2', 'soft_deleted_at')).toBeNull();

    // And the real run actually soft-deletes exactly those parent-driven children.
    await run();
    expect(await col('token_vault', 'test-purge-pdc', 'soft_deleted_at')).not.toBeNull();
    expect(await col('redaction_findings', 'test-purge-pdc2', 'soft_deleted_at')).not.toBeNull();
  });

  it('groupCounts.calls counts distinct orphan calls, not child rows (dry-run and real agree)', async () => {
    // One call, TWO orphan vault rows (no raw parent), both past soft(10). The per-table action
    // count is a ROW count (2), but the grouped call count must be DISTINCT calls (1) — and the
    // dry-run and the real run must agree.
    await ensureCall('test-purge-orphan-calls');
    for (const token of ['[NAME_1]', '[NAME_2]']) {
      await rawOwner.query(
        `INSERT INTO token_vault (call_id, token, ciphertext, key_version, retention_eligible_at)
         VALUES ($1, $2, $3, 1, $4)`,
        ['test-purge-orphan-calls', token, Buffer.from('cipher'), daysAgo(20)],
      );
    }

    const dry = await run(purgeConfig({ RETENTION_DRY_RUN: true }));
    const dryVault = dry.actions.find(
      (a) => a.table === 'token_vault' && a.action === 'soft_delete',
    );
    const dryCalls = dry.groupCounts.find((g) => g.group === 'RAW' && g.action === 'soft_delete');
    expect(dryVault?.count).toBe(2);
    expect(dryCalls?.calls).toBe(1);

    const real = await run();
    const realVault = real.actions.find(
      (a) => a.table === 'token_vault' && a.action === 'soft_delete',
    );
    const realCalls = real.groupCounts.find((g) => g.group === 'RAW' && g.action === 'soft_delete');
    expect(realVault?.count).toBe(2);
    expect(realCalls?.calls).toBe(1);
  });

  it('held-cap purge honors the batch size across a backlog (batch=1, two candidates)', async () => {
    const id1 = await seedReview('test-purge-batch1', 'unresolvable', daysAgo(5));
    await seedRaw('test-purge-batch1', null);
    await seedVault('test-purge-batch1', null);
    const id2 = await seedReview('test-purge-batch2', 'unresolvable', daysAgo(6));
    await seedRaw('test-purge-batch2', null);
    await seedVault('test-purge-batch2', null);

    const report = await run(purgeConfig({ RETENTION_PURGE_BATCH_SIZE: 1 }));

    // Both drained despite batch=1 (the loop re-fetches until empty).
    expect(await rowExists('raw_transcripts', 'test-purge-batch1')).toBe(false);
    expect(await rowExists('raw_transcripts', 'test-purge-batch2')).toBe(false);
    expect(await rowExists('token_vault', 'test-purge-batch1')).toBe(false);
    for (const id of [id1, id2]) {
      expect(
        (
          await owner.query<{ raw_purged_at: Date | null }>(
            `SELECT raw_purged_at FROM review_queue WHERE id = $1`,
            [id],
          )
        ).rows[0]?.raw_purged_at,
      ).not.toBeNull();
    }
    const capAction = report.actions.find((a) => a.action === 'held_cap_purge');
    expect(capAction?.count).toBe(2);
  });

  it('held-cap converges when the DB-A raw_purged_at stamp fails after the DB-B commit', async () => {
    // Simulate a crash/failure AFTER the DB-B delete+tombstone commit but BEFORE the DB-A audit
    // stamp: a faulty DB-A purge pool whose markRawPurged UPDATE rejects. The DB-B tombstone is
    // the authoritative finality, so the run is fail-loud, and a later run converges idempotently.
    const id = await seedReview('test-purge-converge', 'unresolvable', daysAgo(5)); // > 72h
    await seedRaw('test-purge-converge', null);
    await seedVault('test-purge-converge', null);

    const faultyDbAPool = createAppPool(TEST_DATABASE_URL as string, 'purge_role');
    const faultyDbA = {
      connect: async () => {
        const client = await faultyDbAPool.connect();
        const orig = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (text: unknown, params: unknown) => {
          if (
            typeof text === 'string' &&
            text.includes('UPDATE review_queue') &&
            text.includes('raw_purged_at')
          ) {
            return Promise.reject(
              Object.assign(new Error('injected markRawPurged failure'), { code: 'XX000' }),
            );
          }
          return (orig as (t: unknown, p: unknown) => unknown)(text, params);
        };
        return client;
      },
    } as unknown as Pool;

    // First run: fail-loud after the DB-B commit.
    try {
      await expect(
        runPurge({ pool: faultyDbA, rawPool: rawPurge, config: purgeConfig(), logger, now: NOW }),
      ).rejects.toThrow(/retention purge failed/);
    } finally {
      await faultyDbAPool.end();
    }

    // DB-B finality already landed: raw/vault gone, tombstone present.
    expect(await rowExists('raw_transcripts', 'test-purge-converge')).toBe(false);
    expect(await rowExists('token_vault', 'test-purge-converge')).toBe(false);
    expect(await rowExists('raw_purge_tombstone', 'test-purge-converge')).toBe(true);
    // …but the DB-A audit stamp did NOT land (the UPDATE was rejected).
    expect(
      (
        await owner.query<{ raw_purged_at: Date | null }>(
          `SELECT raw_purged_at FROM review_queue WHERE id = $1`,
          [id],
        )
      ).rows[0]?.raw_purged_at,
    ).toBeNull();

    // A second, healthy run converges with no double effect: DB-B DELETEs are no-ops, the
    // tombstone stays a single ON-CONFLICT-DO-NOTHING row, and the DB-A stamp finally lands.
    await run();
    expect(await rowExists('raw_purge_tombstone', 'test-purge-converge')).toBe(true);
    expect(
      (
        await rawOwner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM raw_purge_tombstone WHERE call_id = $1`,
          ['test-purge-converge'],
        )
      ).rows[0]?.n,
    ).toBe('1');
    expect(
      (
        await owner.query<{ raw_purged_at: Date | null }>(
          `SELECT raw_purged_at FROM review_queue WHERE id = $1`,
          [id],
        )
      ).rows[0]?.raw_purged_at,
    ).not.toBeNull();
  });

  it('RAW block→unblock→purge: a blocking review defers the raw purge until it is resolved', async () => {
    // Symmetric to the CLEAN "held call that never completes" case, for the DB-A pre-filter.
    await seedReview('test-purge-raw-unblock', 'open', daysAgo(1)); // active → blocks
    await seedRaw('test-purge-raw-unblock', daysAgo(20)); // normally soft-eligible (past soft 10)
    await seedVault('test-purge-raw-unblock', daysAgo(20));
    await run();
    // Blocked by the open review → NOT purged despite being past window.
    expect(await col('raw_transcripts', 'test-purge-raw-unblock', 'soft_deleted_at')).toBeNull();
    expect(await col('token_vault', 'test-purge-raw-unblock', 'soft_deleted_at')).toBeNull();

    // Resolve the review → no longer blocking → a later run soft-purges the raw + vault.
    await owner.query(
      `UPDATE review_queue SET status = 'resolved', resolved_at = now() WHERE call_id = $1`,
      ['test-purge-raw-unblock'],
    );
    await run();
    expect(
      await col('raw_transcripts', 'test-purge-raw-unblock', 'soft_deleted_at'),
    ).not.toBeNull();
    expect(await col('token_vault', 'test-purge-raw-unblock', 'soft_deleted_at')).not.toBeNull();
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
    await rawOwner.query(`UPDATE raw_transcripts SET soft_deleted_at = NULL WHERE call_id = $1`, [
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

    // The RAW group (incl. token_vault) runs on the DB-B rawPool now, so the fault is injected
    // there. A DEDICATED DB-B purge pool (ended below) so the monkeypatched connection never leaks
    // back into the shared `rawPurge` pool. The token_vault HARD update throws mid-transaction.
    const faultyRawPool = createRawPurgePool(TEST_RAW_DATABASE_URL as string);
    const faultyRaw = {
      connect: async () => {
        const client = await faultyRawPool.connect();
        const orig = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (text: unknown, params: unknown) => {
          if (
            typeof text === 'string' &&
            text.includes('UPDATE token_vault') &&
            text.includes('hard_deleted_at')
          ) {
            return Promise.reject(
              Object.assign(new Error('injected vault failure'), { code: 'XX000' }),
            );
          }
          return (orig as (t: unknown, p: unknown) => unknown)(text, params);
        };
        return client;
      },
    } as unknown as Pool;

    try {
      await expect(
        runPurge({ pool: purge, rawPool: faultyRaw, config: purgeConfig(), logger, now: NOW }),
      ).rejects.toThrow(/retention purge failed/);
    } finally {
      await faultyRawPool.end();
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

  /**
   * ADR 0009 — `technician_notes` and `note_feedback` are DURABLE. The source guard in
   * `test/db/technician-notes-no-purge-group.test.ts` proves they are in no group; this proves what
   * that MEANS at runtime: rows sitting far past every window are still reported as nothing to do
   * and are still there afterwards.
   */
  describe('durable technician-note stores are never purged (ADR 0009)', () => {
    const CALL = 'test-purge-note';

    async function seedNoteAndFeedback(): Promise<void> {
      await ensureCall(CALL, 'completed');
      // retention_eligible_at is stamped LONG past every configured window (the widest is CLEAN's
      // 365-day hard). If the table were registered anywhere, this row would be eligible.
      await owner.query(
        `INSERT INTO technician_notes
           (call_id, prompt_version, model_id, schema_version, scope_signal, occupancy,
            retention_eligible_at)
         VALUES ($1, 'note-v1', 'model-x', 1, 'single_fixture', 'owner', $2)
         ON CONFLICT (call_id) DO NOTHING`,
        [CALL, daysAgo(9999)],
      );
      await owner.query(
        `INSERT INTO note_feedback
           (call_id, note_prompt_version, reviewer_actor, field_path, verdict, created_at)
         VALUES ($1, 'note-v1', 'purge-test', 'occupancy', 'correct', $2)`,
        [CALL, daysAgo(9999)],
      );
    }

    it('a dry run reports ZERO rows for technician_notes and note_feedback', async () => {
      await seedNoteAndFeedback();
      const report = await runPurge({
        pool: purge,
        rawPool: rawPurge,
        config: purgeConfig(),
        logger,
        now: NOW,
      });
      expect(report.dryRun).toBe(false);

      const dry = await runPurge({
        pool: purge,
        rawPool: rawPurge,
        config: purgeConfig({ RETENTION_DRY_RUN: true }),
        logger,
        now: NOW,
      });
      for (const table of ['technician_notes', 'note_feedback']) {
        expect(
          dry.actions.filter((a) => a.table === table),
          `${table} must appear in no purge action`,
        ).toEqual([]);
        expect(report.actions.filter((a) => a.table === table)).toEqual([]);
      }
    });

    it('a REAL run leaves both rows present and unstamped', async () => {
      await seedNoteAndFeedback();
      await run();

      const note = await owner.query<{
        n: number;
        soft_deleted_at: Date | null;
        hard_deleted_at: Date | null;
      }>(
        `SELECT count(*)::int AS n, min(soft_deleted_at) AS soft_deleted_at,
                min(hard_deleted_at) AS hard_deleted_at
           FROM technician_notes WHERE call_id = $1`,
        [CALL],
      );
      expect(note.rows[0]!.n).toBe(1);
      expect(note.rows[0]!.soft_deleted_at).toBeNull();
      expect(note.rows[0]!.hard_deleted_at).toBeNull();

      const feedback = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM note_feedback WHERE call_id = $1`,
        [CALL],
      );
      expect(feedback.rows[0]!.n).toBe(1);
    });
  });
});
