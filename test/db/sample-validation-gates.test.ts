import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool } from './_pg.js';
import { recordConsent } from '../../src/db/repositories/consent-gates-repo.js';
import {
  assertProcessingGates,
  checkProcessingGates,
  REQUIRED_PROCESSING_GATE_TYPES,
  SAMPLE_VALIDATION_GATES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
  SampleValidationError,
} from '../../src/sample-validation/index.js';

/**
 * The §0.2 processing-gate check for the sample-validation harness (Task 11.1): every required
 * processing gate must be recorded in `consent_gates` before a real-call run; the ServiceTitan
 * matching consent is required ONLY when the run exercises that path.
 */
describe.skipIf(!hasTestDb)('sample-validation consent gates (Task 11.1)', () => {
  let pool!: Pool;

  const ALL_GATE_TYPES = [...REQUIRED_PROCESSING_GATE_TYPES, SERVICETITAN_MATCHING_CONSENT_GATE];

  async function clearGates(): Promise<void> {
    await pool.query(`DELETE FROM consent_gates WHERE gate_type = ANY($1)`, [ALL_GATE_TYPES]);
  }

  async function record(gateType: string): Promise<void> {
    await recordConsent(pool, { gateType, recordedBy: 'task-11-1-test', evidenceRef: 'ref' });
  }

  async function recordAllProcessingGates(): Promise<void> {
    for (const gateType of REQUIRED_PROCESSING_GATE_TYPES) await record(gateType);
  }

  beforeAll(() => {
    pool = makePool();
  });
  beforeEach(clearGates);
  afterAll(async () => {
    await clearGates();
    await pool.end();
  });

  it('lists the five §0.2 processing gates', () => {
    expect([...REQUIRED_PROCESSING_GATE_TYPES]).toEqual([
      SAMPLE_VALIDATION_GATES.dialpad_recording_consent,
      SAMPLE_VALIDATION_GATES.signed_services_agreement,
      SAMPLE_VALIDATION_GATES.signed_data_processing_addendum,
      SAMPLE_VALIDATION_GATES.anthropic_no_training_confirmation,
      SAMPLE_VALIDATION_GATES.anthropic_data_retention_confirmation,
    ]);
  });

  it('reports every processing gate missing when none are recorded', async () => {
    const result = await checkProcessingGates(pool, { requireServiceTitanMatching: false });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...REQUIRED_PROCESSING_GATE_TYPES]);
  });

  it('blocks when even one processing gate is missing', async () => {
    for (const gateType of REQUIRED_PROCESSING_GATE_TYPES) {
      if (gateType !== SAMPLE_VALIDATION_GATES.anthropic_data_retention_confirmation) {
        await record(gateType);
      }
    }
    const result = await checkProcessingGates(pool, { requireServiceTitanMatching: false });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([SAMPLE_VALIDATION_GATES.anthropic_data_retention_confirmation]);

    await expect(
      assertProcessingGates(pool, { requireServiceTitanMatching: false }),
    ).rejects.toMatchObject({ reason: 'missing_consent_gates' });
  });

  it('passes when all processing gates are recorded and ServiceTitan is not exercised', async () => {
    await recordAllProcessingGates();
    const result = await checkProcessingGates(pool, { requireServiceTitanMatching: false });
    expect(result).toEqual({ ok: true, missing: [] });
    await expect(
      assertProcessingGates(pool, { requireServiceTitanMatching: false }),
    ).resolves.toBeUndefined();
  });

  it('requires the ServiceTitan matching consent only when the run exercises that path', async () => {
    await recordAllProcessingGates();

    // Not exercised → not required.
    expect((await checkProcessingGates(pool, { requireServiceTitanMatching: false })).ok).toBe(
      true,
    );

    // Exercised but consent absent → blocked on that one gate.
    const blocked = await checkProcessingGates(pool, { requireServiceTitanMatching: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toEqual([SERVICETITAN_MATCHING_CONSENT_GATE]);

    // Exercised and consent recorded → passes.
    await record(SERVICETITAN_MATCHING_CONSENT_GATE);
    expect((await checkProcessingGates(pool, { requireServiceTitanMatching: true })).ok).toBe(true);
  });

  it('surfaces the missing gate list in the thrown error context', async () => {
    let caught: unknown;
    try {
      await assertProcessingGates(pool, { requireServiceTitanMatching: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SampleValidationError);
    expect((caught as SampleValidationError).context.missing).toEqual(ALL_GATE_TYPES);
  });
});
