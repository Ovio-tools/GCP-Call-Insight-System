import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool } from './_pg.js';
import { listByType } from '../../src/db/repositories/consent-gates-repo.js';
import { runRecordConsent } from '../../src/scripts/record-consent.js';
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
} from '../../src/sample-validation/index.js';

describe.skipIf(!hasTestDb)('record-consent CLI (runRecordConsent)', () => {
  let pool!: Pool;
  const ALL = [...REQUIRED_PROCESSING_GATE_TYPES, SERVICETITAN_MATCHING_CONSENT_GATE];

  async function clearGates(): Promise<void> {
    await pool.query(`DELETE FROM consent_gates WHERE gate_type = ANY($1)`, [ALL]);
  }

  beforeAll(() => {
    pool = makePool();
  });
  beforeEach(clearGates);
  afterAll(async () => {
    await clearGates();
    await pool.end();
  });

  it('inserts exactly one row for a fresh gate', async () => {
    const res = await runRecordConsent(pool, {
      gateType: 'dialpad_recording_consent',
      recordedBy: 'Jane Doe',
      note: 'email 2026-06-30',
      force: false,
    });
    expect(res.inserted).toBe(true);
    expect(res.alreadyRecorded).toBe(false);
    expect(res.recordedAt).toBeInstanceOf(Date);
    const rows = await listByType(pool, 'dialpad_recording_consent');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recorded_by: 'Jane Doe', evidence_ref: 'email 2026-06-30' });
  });

  it('is idempotent — a second run without --force inserts nothing', async () => {
    const input = {
      gateType: 'signed_services_agreement',
      recordedBy: 'A',
      note: 'r1',
      force: false,
    };
    await runRecordConsent(pool, input);
    const res = await runRecordConsent(pool, { ...input, recordedBy: 'B', note: 'r2' });
    expect(res.inserted).toBe(false);
    expect(res.alreadyRecorded).toBe(true);
    expect(res.existingRecordedBy).toBe('A');
    const rows = await listByType(pool, 'signed_services_agreement');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recorded_by).toBe('A');
  });

  it('--force inserts an additional row', async () => {
    const input = {
      gateType: 'signed_data_processing_addendum',
      recordedBy: 'A',
      note: 'r1',
      force: false,
    };
    await runRecordConsent(pool, input);
    const res = await runRecordConsent(pool, { ...input, force: true, note: 'r2' });
    expect(res.inserted).toBe(true);
    const rows = await listByType(pool, 'signed_data_processing_addendum');
    expect(rows).toHaveLength(2);
  });

  it('reports which required processing gates remain missing', async () => {
    const res = await runRecordConsent(pool, {
      gateType: 'dialpad_recording_consent',
      recordedBy: 'A',
      note: 'r',
      force: false,
    });
    expect(res.missingProcessingGates).toEqual(
      REQUIRED_PROCESSING_GATE_TYPES.filter((g) => g !== 'dialpad_recording_consent'),
    );
  });

  it('reports no missing gates once all five are recorded', async () => {
    let res: Awaited<ReturnType<typeof runRecordConsent>> | undefined;
    for (const g of REQUIRED_PROCESSING_GATE_TYPES) {
      res = await runRecordConsent(pool, { gateType: g, recordedBy: 'A', note: 'r', force: false });
    }
    expect(res?.missingProcessingGates).toEqual([]);
  });
});
