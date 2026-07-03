import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeTestConfig } from '../_config.js';
import {
  type ModelRates,
  estimateCostUsd,
  estimatePayloadTokens,
  releaseModelReservation,
  reserveModelBudget,
  settleModelUsage,
  utcDay,
} from '../../src/model/cost.js';
import { getDay } from '../../src/db/repositories/daily-cost-usage-repo.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool } from '../db/_dal.js';

/** Haiku-shaped rates, always passed explicitly — the module has NO default pricing. */
const HAIKU_RATES: ModelRates = { inputUsdPerMtok: 1, outputUsdPerMtok: 5 };

describe('estimateCostUsd', () => {
  it('computes USD from explicit per-Mtok rates', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, rates: HAIKU_RATES })).toBe(
      1,
    );
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000, rates: HAIKU_RATES })).toBe(
      5,
    );
    expect(
      estimateCostUsd({ inputTokens: 30_000, outputTokens: 512, rates: HAIKU_RATES }),
    ).toBeCloseTo(0.03256, 10);
  });

  it('classify wiring: rates come from CLASSIFY_COST_USD_PER_MTOK_* config values', () => {
    const config = makeTestConfig({
      CLASSIFY_COST_USD_PER_MTOK_INPUT: 0.8,
      CLASSIFY_COST_USD_PER_MTOK_OUTPUT: 4,
    });
    // The classify caller builds ModelRates from its own config keys; a caller omitting
    // rates is a compile error (the field is required), so pricing can never be inherited.
    const rates: ModelRates = {
      inputUsdPerMtok: config.CLASSIFY_COST_USD_PER_MTOK_INPUT,
      outputUsdPerMtok: config.CLASSIFY_COST_USD_PER_MTOK_OUTPUT,
    };
    expect(estimateCostUsd({ inputTokens: 500_000, outputTokens: 250_000, rates })).toBeCloseTo(
      0.8 * 0.5 + 4 * 0.25,
      10,
    );
  });
});

describe('estimatePayloadTokens', () => {
  it('is UTF-8 byte length + overhead for punctuation-heavy ASCII', () => {
    const system = 'You are a call classifier.';
    const userText = '!!!???;;;,,,---(((...)))"quoted" [bracketed] {braced} <tagged> a.b.c-d_e';
    const outputFormatJson = '{"type":"object","properties":{"label":{"type":"string"}}}';
    const bytes = Buffer.byteLength(system + userText + outputFormatJson, 'utf8');
    // ASCII: 1 byte per char, and a token always encodes >= 1 byte, so this bounds any
    // tokenizer's count no matter how punctuation fragments into single-char tokens.
    expect(bytes).toBe((system + userText + outputFormatJson).length);
    expect(
      estimatePayloadTokens({ system, userText, outputFormatJson, overheadTokens: 1_000 }),
    ).toBe(bytes + 1_000);
  });

  it('counts bytes, not chars, for multi-byte Unicode (bytes > chars)', () => {
    const userText = 'héllo — ½ price ☎ 日本語のテキスト 🙂🙂🙂';
    const combined = 'sys' + userText + '{}';
    const bytes = Buffer.byteLength(combined, 'utf8');
    expect(bytes).toBeGreaterThan(combined.length); // multi-byte really in play
    expect(
      estimatePayloadTokens({
        system: 'sys',
        userText,
        outputFormatJson: '{}',
        overheadTokens: 1_000,
      }),
    ).toBe(bytes + 1_000);
  });

  it('the overhead term alone can decide whether the reservation fits under the cap', () => {
    // Degenerate rates make 1 token cost 1 USD so the cap reads directly in tokens.
    const rates: ModelRates = { inputUsdPerMtok: 1_000_000, outputUsdPerMtok: 0 };
    const payload = { system: '', userText: 'x'.repeat(1_000), outputFormatJson: '' };
    const capUsd = 1_500;
    const withoutOverhead = estimatePayloadTokens({ ...payload, overheadTokens: 0 });
    const withOverhead = estimatePayloadTokens({ ...payload, overheadTokens: 1_000 });
    const costOf = (tokens: number) =>
      estimateCostUsd({ inputTokens: tokens, outputTokens: 0, rates });
    expect(costOf(withoutOverhead)).toBeLessThanOrEqual(capUsd);
    expect(costOf(withOverhead)).toBeGreaterThan(capUsd);
  });
});

describe('utcDay', () => {
  it('derives the UTC calendar day from an injected Date', () => {
    expect(utcDay(new Date('1999-01-05T00:30:00Z'))).toBe('1999-01-05');
    expect(utcDay(new Date('1999-01-05T23:59:59.999Z'))).toBe('1999-01-05');
  });

  it('uses UTC, never a local offset', () => {
    // 22:00 on Jan 5 at UTC-5 is already 03:00 Jan 6 UTC — the UTC day wins.
    expect(utcDay(new Date('1999-01-05T22:00:00-05:00'))).toBe('1999-01-06');
  });
});

/** Unusual test days ('1999-01-XX') so nothing collides with real rows or the repo
 * tests ('1999-02-XX'). Cleaned by range in beforeAll/afterAll. */
const DAYS_FROM = '1999-01-01';
const DAYS_TO = '1999-01-31';

describe.skipIf(!hasTestDb)('model budget reservation / settlement (DB)', () => {
  let owner!: Pool;
  let app!: Pool;

  // 0.25 + 0.25 lands exactly on the 0.5 cap (both exactly representable in binary).
  const config = makeTestConfig({ DAILY_MODEL_COST_CAP_USD: 0.5 });
  const at = (day: string) => new Date(`${day}T12:00:00Z`);

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

  it('reserves while under the cap and records the reservation on the day row', async () => {
    const day = '1999-01-02';
    const r = await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 });
    expect(r).toEqual({ day, reservedUsd: 0.25 });
    const row = await getDay(app, day);
    expect(row?.estimated_cost).toBe('0.250000');
    expect(row?.input_tokens).toBe('0');
    expect(row?.output_tokens).toBe('0');
  });

  it('admits a reservation landing exactly on the cap, refuses the next, writes nothing for it', async () => {
    const day = '1999-01-03';
    expect(
      await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 }),
    ).not.toBeNull();
    // estimated_cost + requestCost == cap → still admitted (<=, not <).
    expect(
      await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 }),
    ).not.toBeNull();
    expect(
      await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.000001 }),
    ).toBeNull();
    const row = await getDay(app, day);
    expect(row?.estimated_cost).toBe('0.500000'); // the refused attempt reserved nothing
  });

  it('settlement replaces the reservation with actual tokens and actual cost', async () => {
    const day = '1999-01-04';
    const r = await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 });
    expect(r).not.toBeNull();
    if (!r) return;
    await settleModelUsage(app, r, {
      inputTokens: 100_000,
      outputTokens: 10_000,
      rates: HAIKU_RATES,
    });
    const row = await getDay(app, day);
    expect(row?.estimated_cost).toBe('0.150000'); // (100k*1 + 10k*5) / 1M — actuals, not the reservation
    expect(row?.input_tokens).toBe('100000');
    expect(row?.output_tokens).toBe('10000');
  });

  it('release subtracts the full reservation and records no tokens', async () => {
    const day = '1999-01-05';
    const r = await reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 });
    expect(r).not.toBeNull();
    if (!r) return;
    await releaseModelReservation(app, r);
    const row = await getDay(app, day);
    expect(row?.estimated_cost).toBe('0.000000');
    expect(row?.input_tokens).toBe('0');
    expect(row?.output_tokens).toBe('0');
  });

  it('6 parallel reservations with headroom for 2 admit exactly 2 — committed row proves it', async () => {
    const day = '1999-01-06';
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserveModelBudget(app, { config, now: at(day), requestCostUsd: 0.25 }),
      ),
    );
    const admitted = results.filter((r) => r !== null);
    expect(admitted).toHaveLength(2);
    // The committed day row — read on a separate pool — shows exactly k reservations,
    // not just k non-null return values.
    const row = await getDay(owner, day);
    expect(row?.estimated_cost).toBe('0.500000');
  });
});
