import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, seedKeyVersion } from '../db/_dal.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';
import { runReconciliationCron } from '../../src/reconciliation/run.js';
import { syncLabeledExamples } from '../../src/evaluation/sync.js';
import { listAcceptedExamples } from '../../src/db/repositories/labeled-examples-repo.js';

/**
 * Dependable label capture wired through the reconciliation cron (Task 6.3, findings R4-1/R5-1): a
 * cron tick after a resolved correction mines an accepted label and pings; a purged clean transcript
 * writes exactly one content-free `missing_clean` rejection that does NOT duplicate on the next tick.
 */
const CHECK_URL = 'https://checks.example.com/ping/reconciliation';

describe.skipIf(!hasTestDb)('reconciliation cron label-sync duty (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  const P = 'lsduty-';

  async function seedSpam(callId: string, withClean: boolean): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'classified_spam', now() + interval '1 hour') RETURNING id`,
      [callId],
    );
    await owner.query(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'r', 'mark_spam', '{}'::jsonb, '{"action_params":{}}'::jsonb)`,
      [rq.rows[0]!.id],
    );
    if (withClean) {
      await owner.query(
        `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons)
         VALUES ($1, 'a clean redacted transcript', 0.1, '[]'::jsonb)`,
        [callId],
      );
    }
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
      [`${P}%`],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM clean_transcripts WHERE call_id LIKE $1`, [`${P}%`]);
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [`${P}%`]);
  }

  function makeCronDeps(labelSync: () => Promise<{ failed: number }>) {
    const { logger } = makeCapturingLogger();
    const ping = vi.fn((_url: string) => Promise.resolve());
    return {
      config: makeTestConfig({ RECONCILIATION_CHECK_URL: CHECK_URL }),
      logger,
      runSweep: () => Promise.resolve(),
      runScan: () => Promise.resolve({ escalated: 0, failed: 0, lockedSkipped: 0 }),
      runDrain: () => Promise.resolve({ failed: 0 }),
      runLabelSync: labelSync,
      ping,
      onSweepError: () => Promise.resolve(),
      _ping: ping,
    };
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('captures an accepted label on a cron tick and pings', async () => {
    await seedSpam(`${P}ok`, true);
    const { logger } = makeCapturingLogger();
    const deps = makeCronDeps(async () => {
      const s = await syncLabeledExamples(app, { denyTerms: [], logger });
      return { failed: s.failed };
    });
    await runReconciliationCron(deps);
    expect(deps._ping).toHaveBeenCalledTimes(1);
    const rows = (await listAcceptedExamples(app)).filter((r) => r.call_id === `${P}ok`);
    expect(rows).toHaveLength(1);
  });

  it('records one content-free missing_clean rejection that does not duplicate on the next tick', async () => {
    await seedSpam(`${P}miss`, false);
    const { logger } = makeCapturingLogger();
    const run = () =>
      runReconciliationCron(
        makeCronDeps(async () => {
          const s = await syncLabeledExamples(app, { denyTerms: [], logger });
          return { failed: s.failed };
        }),
      );
    await run();
    await run();
    const rej = await owner.query(
      `SELECT rejection_reason FROM labeled_example_rejections WHERE call_id = $1`,
      [`${P}miss`],
    );
    expect(rej.rows).toHaveLength(1);
    expect((rej.rows[0] as { rejection_reason: string }).rejection_reason).toBe('missing_clean');
  });
});
