import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repositories } from '../../src/db/index.js';
import {
  PII_SCAN_FAILURE_KINDS,
  PII_SCAN_STATUSES,
  SENTIMENTS,
  SERVICE_CATEGORIES,
} from '../../src/db/enums.js';
import type { ExtractionCandidateInsert } from '../../src/db/schemas/extraction-candidates.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';

const PATTERN = 'test-exc-%';

/** A full valid insert payload; tests override what they probe. */
function baseInsert(callId: string): ExtractionCandidateInsert {
  return {
    callId,
    callIntent: 'new_booking',
    serviceCategory: 'water_heater',
    problemStatement: 'no hot water since yesterday',
    symptoms: ['no hot water'],
    customerLanguage: ['the water heater is completely dead'],
    locationInHome: 'basement',
    accessOrSchedulingNotes: null,
    priorAttempts: null,
    urgency: 'routine',
    concerns: ['cost'],
    sentiment: 'neutral',
    acquisitionSource: null,
    competitorMentions: [],
    schemaVersion: 1,
    promptVersion: 'extract-v1',
    modelId: 'claude-sonnet-4-5',
  };
}

describe.skipIf(!hasTestDb)('extraction_candidates repository', () => {
  let owner!: Pool;
  let app!: Pool;

  async function seedCall(callId: string): Promise<void> {
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'extract',
      status: 'processing',
    });
  }

  /** Raw row read on the owner pool — sees soft/hard-deleted rows the DAL filters. */
  async function rawRow(callId: string): Promise<Record<string, unknown> | undefined> {
    const res = await owner.query(`SELECT * FROM extraction_candidates WHERE call_id = $1`, [
      callId,
    ]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM extraction_candidates WHERE call_id LIKE $1`, [PATTERN]);
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('upsert is idempotent: one row, latest values, pending scan status', async () => {
    const callId = 'test-exc-idem';
    await seedCall(callId);
    await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
    const second = await repositories.extractionCandidates.upsertExtractionCandidate(app, {
      ...baseInsert(callId),
      serviceCategory: 'drain_blockage',
      sentiment: 'frustrated',
      customerLanguage: ['everything is backed up'],
    });
    expect(second.service_category).toBe('drain_blockage');
    expect(second.sentiment).toBe('frustrated');
    expect(second.customer_language).toEqual(['everything is backed up']);
    expect(second.pii_scan_status).toBe('pending');
    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM extraction_candidates WHERE call_id = $1`,
      [callId],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('upsert resets the failed latch and clears a soft delete (the only reset path)', async () => {
    const callId = 'test-exc-latch-reset';
    await seedCall(callId);
    await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
    await repositories.extractionCandidates.markPiiScanFailed(app, callId, {
      kind: 'residual_pii',
      counts: { digit_run: 2 },
    });
    await repositories.extractionCandidates.softDeleteExtractionCandidate(app, callId);

    const rerun = await repositories.extractionCandidates.upsertExtractionCandidate(
      app,
      baseInsert(callId),
    );
    expect(rerun.pii_scan_status).toBe('pending');
    expect(rerun.pii_scan_failure_kind).toBeNull();
    expect(rerun.pii_scan_failed_at).toBeNull();
    expect(rerun.pii_scan_counts).toBeNull();
    expect(rerun.soft_deleted_at).toBeNull();
  });

  it('upsert clears retention_eligible_at (re-extracted candidate awaits a new store+stamp cycle)', async () => {
    const callId = 'test-exc-retention-reset';
    await seedCall(callId);
    await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
    // Simulate Task 5.3 stamping retention after copying to structured_knowledge.
    await owner.query(
      `UPDATE extraction_candidates SET retention_eligible_at = now() WHERE call_id = $1`,
      [callId],
    );

    const rerun = await repositories.extractionCandidates.upsertExtractionCandidate(
      app,
      baseInsert(callId),
    );
    // A stale stamp here would let the retention cron hard-delete the fresh
    // in-flight candidate mid-scan.
    expect(rerun.retention_eligible_at).toBeNull();
  });

  it('upsert refuses to repopulate a hard-deleted row', async () => {
    const callId = 'test-exc-hard-del';
    await seedCall(callId);
    await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
    await owner.query(
      `UPDATE extraction_candidates SET hard_deleted_at = now() WHERE call_id = $1`,
      [callId],
    );
    await expect(
      repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId)),
    ).rejects.toMatchObject({ code: 'DAL_QUERY_FAILED' });
    expect(
      await repositories.extractionCandidates.hasHardDeletedExtractionCandidate(app, callId),
    ).toBe(true);
  });

  it('getExtractionCandidate filters soft- and hard-deleted rows', async () => {
    const callId = 'test-exc-get-filter';
    await seedCall(callId);
    await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
    expect(
      await repositories.extractionCandidates.getExtractionCandidate(app, callId),
    ).toBeDefined();

    await repositories.extractionCandidates.softDeleteExtractionCandidate(app, callId);
    expect(
      await repositories.extractionCandidates.getExtractionCandidate(app, callId),
    ).toBeUndefined();

    await owner.query(
      `UPDATE extraction_candidates SET hard_deleted_at = now() WHERE call_id = $1`,
      [callId],
    );
    expect(
      await repositories.extractionCandidates.getExtractionCandidate(app, callId),
    ).toBeUndefined();
  });

  describe('SQL CHECK constraints (owner-pool direct writes)', () => {
    const callId = 'test-exc-check';

    async function insertRaw(overrides: Record<string, string | null>): Promise<void> {
      const cols = {
        service_category: 'water_heater',
        sentiment: 'neutral',
        pii_scan_status: 'pending',
        pii_scan_failure_kind: null,
        ...overrides,
      };
      await owner.query(
        `INSERT INTO extraction_candidates (
           call_id, call_intent, service_category, urgency, sentiment,
           pii_scan_status, pii_scan_failure_kind, schema_version, prompt_version, model_id)
         VALUES ($1, 'new_booking', $2, 'routine', $3, $4, $5, 1, 'v1', 'm1')`,
        [
          callId,
          cols.service_category,
          cols.sentiment,
          cols.pii_scan_status,
          cols.pii_scan_failure_kind,
        ],
      );
    }

    beforeAll(async () => {
      await seedCall(callId);
    });

    it('rejects an uncontrolled service_category', async () => {
      await expect(insertRaw({ service_category: 'hvac' })).rejects.toThrow(
        /extraction_candidates_service_category_chk/,
      );
    });

    it('rejects an uncontrolled sentiment', async () => {
      await expect(insertRaw({ sentiment: 'ecstatic' })).rejects.toThrow(
        /extraction_candidates_sentiment_chk/,
      );
    });

    it('rejects an uncontrolled pii_scan_status', async () => {
      await expect(insertRaw({ pii_scan_status: 'maybe' })).rejects.toThrow(
        /extraction_candidates_pii_scan_status_chk/,
      );
    });

    it('rejects an uncontrolled pii_scan_failure_kind', async () => {
      await expect(
        insertRaw({ pii_scan_status: 'failed', pii_scan_failure_kind: 'gremlins' }),
      ).rejects.toThrow(/extraction_candidates_pii_scan_failure_kind_chk/);
    });

    it('rejects failed status without a failure kind', async () => {
      await expect(
        insertRaw({ pii_scan_status: 'failed', pii_scan_failure_kind: null }),
      ).rejects.toThrow(/extraction_candidates_failed_kind_chk/);
    });

    it('rejects a failure kind on a non-failed status', async () => {
      await expect(
        insertRaw({ pii_scan_status: 'pending', pii_scan_failure_kind: 'residual_pii' }),
      ).rejects.toThrow(/extraction_candidates_failed_kind_chk/);
    });

    // Positive TS/DB parity loops (convention: call-state-drop.test.ts "stores every
    // DROP_REASONS value"): every value the TS tuples allow must also pass the SQL
    // CHECKs, so the two vocabularies cannot drift apart silently in either direction.
    async function insertParityRaw(
      id: string,
      overrides: Record<string, string | null>,
    ): Promise<void> {
      const cols = {
        service_category: 'water_heater',
        sentiment: 'neutral',
        pii_scan_status: 'pending',
        pii_scan_failure_kind: null,
        ...overrides,
      };
      await seedCall(id);
      await owner.query(
        `INSERT INTO extraction_candidates (
           call_id, call_intent, service_category, urgency, sentiment,
           pii_scan_status, pii_scan_failure_kind, schema_version, prompt_version, model_id)
         VALUES ($1, 'new_booking', $2, 'routine', $3, $4, $5, 1, 'v1', 'm1')`,
        [
          id,
          cols.service_category,
          cols.sentiment,
          cols.pii_scan_status,
          cols.pii_scan_failure_kind,
        ],
      );
    }

    it('accepts every SERVICE_CATEGORIES value (TS/DB parity)', async () => {
      for (const category of SERVICE_CATEGORIES) {
        const id = `test-exc-parity-cat-${category}`;
        await seedCall(id);
        const row = await repositories.extractionCandidates.upsertExtractionCandidate(app, {
          ...baseInsert(id),
          serviceCategory: category,
        });
        expect(row.service_category).toBe(category);
      }
    });

    it('accepts every SENTIMENTS value (TS/DB parity)', async () => {
      for (const sentiment of SENTIMENTS) {
        const id = `test-exc-parity-sent-${sentiment}`;
        await seedCall(id);
        const row = await repositories.extractionCandidates.upsertExtractionCandidate(app, {
          ...baseInsert(id),
          sentiment,
        });
        expect(row.sentiment).toBe(sentiment);
      }
    });

    it('accepts every PII_SCAN_STATUSES value (TS/DB parity)', async () => {
      for (const status of PII_SCAN_STATUSES) {
        const id = `test-exc-parity-status-${status}`;
        // The failed⇔kind row CHECK: 'failed' must carry a kind, others must not.
        await insertParityRaw(id, {
          pii_scan_status: status,
          pii_scan_failure_kind: status === 'failed' ? 'residual_pii' : null,
        });
        const res = await owner.query<{ pii_scan_status: string }>(
          `SELECT pii_scan_status FROM extraction_candidates WHERE call_id = $1`,
          [id],
        );
        expect(res.rows[0]?.pii_scan_status).toBe(status);
      }
    });

    it('accepts every PII_SCAN_FAILURE_KINDS value (TS/DB parity)', async () => {
      for (const kind of PII_SCAN_FAILURE_KINDS) {
        const id = `test-exc-parity-kind-${kind}`;
        // The failed⇔kind row CHECK: a kind is only legal alongside status='failed'.
        await insertParityRaw(id, { pii_scan_status: 'failed', pii_scan_failure_kind: kind });
        const res = await owner.query<{ pii_scan_failure_kind: string }>(
          `SELECT pii_scan_failure_kind FROM extraction_candidates WHERE call_id = $1`,
          [id],
        );
        expect(res.rows[0]?.pii_scan_failure_kind).toBe(kind);
      }
    });
  });

  describe('markPiiScanFailed', () => {
    it('scrubs customer_language and stamps kind/failed_at/counts in one statement', async () => {
      const callId = 'test-exc-fail-scrub';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      const failed = await repositories.extractionCandidates.markPiiScanFailed(app, callId, {
        kind: 'residual_pii',
        counts: { digit_run: 2, deny_list_term: 1 },
      });
      expect(failed.customer_language).toEqual([]);
      expect(failed.pii_scan_status).toBe('failed');
      expect(failed.pii_scan_failure_kind).toBe('residual_pii');
      expect(failed.pii_scan_failed_at).toBeInstanceOf(Date);
      expect(failed.pii_scan_counts).toEqual({ digit_run: 2, deny_list_term: 1 });
    });

    it('overwrites a previously passed row (deny-list change re-scan)', async () => {
      const callId = 'test-exc-fail-after-pass';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      await repositories.extractionCandidates.markPiiScanPassed(app, callId);
      const failed = await repositories.extractionCandidates.markPiiScanFailed(app, callId, {
        kind: 'tokened_phrase',
        dropped_count: 1,
      });
      expect(failed.pii_scan_status).toBe('failed');
      expect(failed.pii_scan_failure_kind).toBe('tokened_phrase');
      expect(failed.pii_scan_counts).toEqual({ dropped_count: 1 });
    });

    it('accepts every valid failure shape', async () => {
      const callId = 'test-exc-fail-shapes';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      const mismatch = await repositories.extractionCandidates.markPiiScanFailed(app, callId, {
        kind: 'verbatim_mismatch',
        mismatch_count: 1,
        phrase_count: 3,
      });
      expect(mismatch.pii_scan_counts).toEqual({ mismatch_count: 1, phrase_count: 3 });
    });

    it('rejects PII-shaped payloads with zod BEFORE any SQL runs', async () => {
      const callId = 'test-exc-fail-validate';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      const before = await rawRow(callId);
      expect(before).toBeDefined();

      const badPayloads: unknown[] = [
        // value is a phone number, key uncontrolled
        { kind: 'residual_pii', counts: { phrase: '555-1212' } },
        // controlled key but PII-shaped string value
        { kind: 'residual_pii', counts: { digit_run: '555-1212' } },
        // PII-shaped keys outside the closed category vocabulary
        { kind: 'residual_pii', counts: { john_smith: 1 } },
        { kind: 'residual_pii', counts: { main_street: 1 } },
        // unknown kind
        { kind: 'name_leak', counts: { digit_run: 1 } },
        // a recorded residual failure with zero hits is nonsensical
        { kind: 'residual_pii', counts: {} },
      ];
      for (const payload of badPayloads) {
        await expect(
          repositories.extractionCandidates.markPiiScanFailed(app, callId, payload as never),
        ).rejects.toMatchObject({ code: 'DAL_VALIDATION_FAILED' });
      }

      // No SQL ran: the row's values are unchanged.
      expect(await rawRow(callId)).toEqual(before);
    });

    it('throws on a missing or deleted row', async () => {
      await expect(
        repositories.extractionCandidates.markPiiScanFailed(app, 'test-exc-fail-missing', {
          kind: 'tokened_phrase',
          dropped_count: 1,
        }),
      ).rejects.toMatchObject({ code: 'DAL_QUERY_FAILED' });
    });
  });

  describe('pii scan latch', () => {
    it('markPiiScanPassed moves pending to passed', async () => {
      const callId = 'test-exc-pass';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      const row = await repositories.extractionCandidates.markPiiScanPassed(app, callId);
      expect(row?.pii_scan_status).toBe('passed');
    });

    it('markPiiScanPassed can never overwrite failed (one-way latch)', async () => {
      const callId = 'test-exc-latch';
      await seedCall(callId);
      await repositories.extractionCandidates.upsertExtractionCandidate(app, baseInsert(callId));
      await repositories.extractionCandidates.markPiiScanFailed(app, callId, {
        kind: 'residual_pii',
        counts: { email_like: 1 },
      });
      const result = await repositories.extractionCandidates.markPiiScanPassed(app, callId);
      expect(result).toBeUndefined();
      const raw = await rawRow(callId);
      expect(raw?.pii_scan_status).toBe('failed');
    });
  });
});
