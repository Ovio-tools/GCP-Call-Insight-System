import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { buildStatus } from '../../src/status/aggregate.js';
import { makeTestConfig } from '../_config.js';

/** A pool whose every query throws — every status signal must degrade, never 500. */
const failingPool = {
  query: () => Promise.reject(new Error('DB down')),
} as unknown as Pool;

const silentLogger = { warn: () => undefined, info: () => undefined } as unknown as Logger;
const NOW = new Date('2026-07-01T12:00:00.000Z');

describe('buildStatus degradation (every signal fails)', () => {
  it('renders unknown/null everywhere without throwing', async () => {
    // Both model flags enabled so the pause state depends on the (failing) cost lookup →
    // unknown, rather than a kill-switch-forced `paused`.
    const config = makeTestConfig({ CLASSIFY_ENABLED: true, EXTRACT_ENABLED: true });
    const dto = await buildStatus(failingPool, { config, now: NOW, logger: silentLogger });

    expect(dto.summary.calls_processed_today).toBeNull();
    expect(dto.summary.calls_held_for_review).toBeNull();
    expect(dto.summary.held_by_reason).toBeNull();
    expect(dto.summary.dead_letter_count).toBeNull();
    expect(dto.summary.spend.spent_usd).toBeNull();
    expect(dto.summary.spend.model_paused).toBeNull(); // unknown, NOT false
    expect(dto.summary.spend.budget_usd).toBe(config.DAILY_MODEL_COST_CAP_USD);
    expect(dto.summary.latest_issue).toBeNull();
    expect(dto.summary.pipeline_state).toBe('unknown');

    expect(dto.pipeline_nodes).toHaveLength(9);
    for (const n of dto.pipeline_nodes) {
      expect(n.count).toBeNull();
      expect(n.state).toBe('unknown');
    }
    expect(dto.components).toHaveLength(4);
    for (const c of dto.components) {
      expect(c.state).toBe('unknown');
      expect(c.last_run_at).toBeNull();
    }
  });

  it('a tripped kill switch forces model_paused=true even when signals fail', async () => {
    const config = makeTestConfig({ CLASSIFY_ENABLED: false, EXTRACT_ENABLED: true });
    const dto = await buildStatus(failingPool, { config, now: NOW, logger: silentLogger });
    expect(dto.summary.spend.model_paused).toBe(true);
    // No alert (query failed) but the kill switch is a known-true pause → paused, not unknown.
    expect(dto.summary.pipeline_state).toBe('paused');
    const classify = dto.pipeline_nodes.find((n) => n.key === 'classify');
    // count is null (stage query failed) → the node still reads unknown, not paused.
    expect(classify?.state).toBe('unknown');
  });
});
