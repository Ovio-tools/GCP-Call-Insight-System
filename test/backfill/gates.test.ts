import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { recordConsent } from '../../src/db/repositories/consent-gates-repo.js';
import {
  assertBackfillProcessingGates,
  deriveServiceTitanMatchingRequirement,
} from '../../src/backfill/gates.js';
import { BackfillError } from '../../src/backfill/errors.js';
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
} from '../../src/sample-validation/gates.js';

describe('deriveServiceTitanMatchingRequirement (pure)', () => {
  it('does NOT require ST matching when no match-key writes happen (default)', () => {
    expect(deriveServiceTitanMatchingRequirement({ writesMatchKeys: false })).toBe(false);
  });
  it('DOES require ST matching when match-key writes happen (--match-keys)', () => {
    expect(deriveServiceTitanMatchingRequirement({ writesMatchKeys: true })).toBe(true);
  });
});

describe.skipIf(!hasTestDb)('assertBackfillProcessingGates', () => {
  let pool!: Pool;

  async function clearGates(): Promise<void> {
    await pool.query(`DELETE FROM consent_gates WHERE recorded_by = 'bf-gates-test'`);
  }
  async function recordAll(types: readonly string[]): Promise<void> {
    for (const gateType of types) {
      await recordConsent(pool, { gateType, recordedBy: 'bf-gates-test' });
    }
  }

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
    await clearGates();
  });
  afterEach(clearGates);
  afterAll(async () => {
    await clearGates();
    await pool.end();
  });

  it.each(REQUIRED_PROCESSING_GATE_TYPES)('blocks when the %s gate is absent', async (missing) => {
    await recordAll(REQUIRED_PROCESSING_GATE_TYPES.filter((g) => g !== missing));
    let caught: unknown;
    try {
      await assertBackfillProcessingGates(pool, { writesMatchKeys: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackfillError);
    expect((caught as BackfillError).reason).toBe('missing_consent_gates');
    expect((caught as BackfillError).context.missing).toContain(missing);
  });

  it('passes when all five §0.2 gates are present (no ST needed)', async () => {
    await recordAll(REQUIRED_PROCESSING_GATE_TYPES);
    await expect(
      assertBackfillProcessingGates(pool, { writesMatchKeys: false }),
    ).resolves.toBeUndefined();
  });

  it('requires the ST matching gate only when writesMatchKeys is true', async () => {
    await recordAll(REQUIRED_PROCESSING_GATE_TYPES);
    // Without the ST gate, a match-keys run is blocked.
    await expect(
      assertBackfillProcessingGates(pool, { writesMatchKeys: true }),
    ).rejects.toBeInstanceOf(BackfillError);
    // Add it → passes.
    await recordConsent(pool, {
      gateType: SERVICETITAN_MATCHING_CONSENT_GATE,
      recordedBy: 'bf-gates-test',
    });
    await expect(
      assertBackfillProcessingGates(pool, { writesMatchKeys: true }),
    ).resolves.toBeUndefined();
  });
});
