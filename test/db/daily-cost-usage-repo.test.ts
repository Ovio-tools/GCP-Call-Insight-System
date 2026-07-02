import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  DAL_COST_ADJUST_REJECTED,
  DAL_VALIDATION_FAILED,
  DalError,
  withTransaction,
} from '../../src/db/index.js';
import {
  adjustDailyCost,
  getDay,
  upsertDailyCost,
} from '../../src/db/repositories/daily-cost-usage-repo.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool } from './_dal.js';

/** Unusual test days ('1999-02-XX') so nothing collides with real rows or the
 * cost-module tests ('1999-01-XX'). Cleaned by range in beforeAll/afterAll. */
const DAYS_FROM = '1999-02-01';
const DAYS_TO = '1999-02-28';

describe.skipIf(!hasTestDb)('daily-cost-usage repo (Task 5.1 adjust path)', () => {
  let owner!: Pool;
  let app!: Pool;

  async function cleanDays(): Promise<void> {
    await owner.query(`DELETE FROM daily_cost_usage WHERE day BETWEEN $1 AND $2`, [
      DAYS_FROM,
      DAYS_TO,
    ]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanDays();
  });
  afterAll(async () => {
    await cleanDays();
    await owner.end();
    await app.end();
  });

  it('adjustDailyCost releases a reservation (negative cost delta, no tokens)', async () => {
    const day = '1999-02-01';
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 0.05 });
    const row = await adjustDailyCost(app, {
      day,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      estimatedCostDelta: -0.05,
    });
    expect(row.estimated_cost).toBe('0.000000');
    expect(row.input_tokens).toBe('0');
    expect(row.output_tokens).toBe('0');
  });

  it('adjustDailyCost settles lower than reserved: cost drops, actual tokens land', async () => {
    const day = '1999-02-02';
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 0.1 });
    const row = await adjustDailyCost(app, {
      day,
      inputTokensDelta: 12_000,
      outputTokensDelta: 300,
      estimatedCostDelta: -0.04,
    });
    expect(row.estimated_cost).toBe('0.060000');
    expect(row.input_tokens).toBe('12000');
    expect(row.output_tokens).toBe('300');
  });

  it('adjustDailyCost allows an exact settlement down to zero', async () => {
    const day = '1999-02-03';
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 0.03 });
    const row = await adjustDailyCost(app, {
      day,
      inputTokensDelta: 500,
      outputTokensDelta: 50,
      estimatedCostDelta: -0.03,
    });
    expect(row.estimated_cost).toBe('0.000000');
  });

  it('adjustDailyCost throws on over-release and leaves the row unchanged', async () => {
    const day = '1999-02-04';
    await upsertDailyCost(app, { day, inputTokens: 0, outputTokens: 0, estimatedCost: 0.05 });
    const err = await adjustDailyCost(app, {
      day,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      estimatedCostDelta: -0.06,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DalError);
    expect((err as DalError).code).toBe(DAL_COST_ADJUST_REJECTED);
    const row = await getDay(app, day);
    expect(row?.estimated_cost).toBe('0.050000');
  });

  it('adjustDailyCost throws when the day row does not exist (0-row update)', async () => {
    const err = await adjustDailyCost(app, {
      day: '1999-02-05',
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      estimatedCostDelta: 0,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DalError);
    expect((err as DalError).code).toBe(DAL_COST_ADJUST_REJECTED);
  });

  it('adjustDailyCost rejects negative token deltas at the schema boundary', async () => {
    for (const bad of [
      { inputTokensDelta: -1, outputTokensDelta: 0 },
      { inputTokensDelta: 0, outputTokensDelta: -1 },
    ]) {
      const err = await adjustDailyCost(app, {
        day: '1999-02-06',
        ...bad,
        estimatedCostDelta: 0,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DalError);
      expect((err as DalError).code).toBe(DAL_VALIDATION_FAILED);
    }
  });

  it('getDay/upsertDailyCost enlist in an open transaction (rollback leaves no row)', async () => {
    const day = '1999-02-07';
    await expect(
      withTransaction(app, async (client) => {
        await upsertDailyCost(client, {
          day,
          inputTokens: 1,
          outputTokens: 2,
          estimatedCost: 0.01,
        });
        const inTx = await getDay(client, day);
        expect(inTx?.input_tokens).toBe('1');
        expect(inTx?.output_tokens).toBe('2');
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(await getDay(app, day)).toBeUndefined();
  });
});
