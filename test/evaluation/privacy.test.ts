import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { makeAppPool, seedKeyVersion } from '../db/_dal.js';
import { syncLabeledExamples } from '../../src/evaluation/sync.js';
import { exportReviewedFixtures } from '../../src/evaluation/export-fixtures.js';

/**
 * No-PII-egress across logs, DB rows, and exported files (Task 6.3). A PII-laced clean transcript
 * is rejected content-free; the digits never reach a log line, a serialized rejection row, or an
 * exported fixture. Positive guards run first so the absence assertions can't pass vacuously.
 */
const PII_DIGITS = '5551234567';

function collectingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = [];
  const rec =
    () =>
    (obj: unknown, msg?: unknown): void => {
      lines.push({ obj, msg });
    };
  const logger = {
    info: rec(),
    warn: rec(),
    error: rec(),
    debug: rec(),
    fatal: rec(),
    trace: rec(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

describe.skipIf(!hasTestDb)('evaluation privacy — no PII egress (Task 6.3)', () => {
  let owner!: Pool;
  let app!: Pool;
  let root: string | undefined;
  const CALL = 'evalpriv-call';

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM labeled_examples WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM labeled_example_rejections WHERE call_id = $1`, [CALL]);
    await owner.query(
      `DELETE FROM operator_actions WHERE review_queue_id IN
        (SELECT id FROM review_queue WHERE call_id = $1)`,
      [CALL],
    );
    await owner.query(`DELETE FROM review_queue WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM clean_transcripts WHERE call_id = $1`, [CALL]);
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await seedKeyVersion(owner);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('rejects PII-laced input content-free and leaks the digits nowhere', async () => {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'classify', 'held') ON CONFLICT (call_id) DO NOTHING`,
      [CALL],
    );
    const rq = await owner.query<{ id: string }>(
      `INSERT INTO review_queue (call_id, held_reason, sla_due_at)
       VALUES ($1, 'classified_spam', now() + interval '1 hour') RETURNING id`,
      [CALL],
    );
    await owner.query(
      `INSERT INTO operator_actions (review_queue_id, actor, action, before, after)
       VALUES ($1, 'reviewer', 'mark_spam', '{}'::jsonb, '{"action_params":{}}'::jsonb)`,
      [rq.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons)
       VALUES ($1, $2, 0.1, '[]'::jsonb)`,
      [CALL, `please call me back at ${PII_DIGITS} today`],
    );

    const { logger, lines } = collectingLogger();
    const summary = await syncLabeledExamples(app, { denyTerms: [], logger });

    // Positive guards first.
    expect(summary.rejected_pii).toBe(1);
    expect(summary.accepted).toBe(0);
    const rej = await owner.query<{
      rejection_reason: string;
      rejection_counts: Record<string, number>;
    }>(
      `SELECT rejection_reason, rejection_counts FROM labeled_example_rejections WHERE call_id = $1`,
      [CALL],
    );
    expect(rej.rows[0]!.rejection_reason).toBe('pii');
    expect(rej.rows[0]!.rejection_counts.digit_run).toBeGreaterThanOrEqual(1);

    // No accepted row.
    const acc = await owner.query(`SELECT 1 FROM labeled_examples WHERE call_id = $1`, [CALL]);
    expect(acc.rows).toHaveLength(0);

    // The digits appear in NO log line and NO serialized rejection row.
    expect(JSON.stringify(lines)).not.toContain(PII_DIGITS);
    expect(JSON.stringify(rej.rows)).not.toContain(PII_DIGITS);

    // And in no exported fixture (there are none — but assert over the whole output dir).
    root = mkdtempSync(join(tmpdir(), 'eval-priv-'));
    await exportReviewedFixtures(app, {
      classifyDir: join(root, 'classify', 'reviewed'),
      extractDir: join(root, 'extract', 'reviewed'),
    });
    for (const dir of [join(root, 'classify', 'reviewed'), join(root, 'extract', 'reviewed')]) {
      for (const f of readdirSync(dir)) {
        expect(readFileSync(join(dir, f), 'utf8')).not.toContain(PII_DIGITS);
      }
    }
  });
});
