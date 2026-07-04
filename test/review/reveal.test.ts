import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postReveal, type ReviewHarness } from './_harness.js';

const PATTERN = 'test-rvreveal-%';
const RAW = 'Hi this is Jane Doe at 555-123-4567, my heater is broken.';

describe.skipIf(!hasTestDb)('review reveal-raw (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const revealAudits = async (id: string) =>
    (
      await h.owner.query<{ action: string; after: Record<string, unknown> }>(
        `SELECT action, after FROM operator_actions WHERE review_queue_id = $1`,
        [id],
      )
    ).rows;

  async function seedRevealable(callId: string): Promise<string> {
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedRawTranscript(callId, RAW);
    return reviewId;
  }

  it('a standard reviewer is refused (403 AUTH_FORBIDDEN), no audit row', async () => {
    const callId = 'test-rvreveal-forbidden';
    const reviewId = await seedRevealable(callId);
    const session = await h.login({ elevated: false });
    const res = await postReveal(h, session, reviewId);
    expect(res.status).toBe(403);
    expect((res.json() as { error: string }).error).toBe('AUTH_FORBIDDEN');
    expect(await revealAudits(reviewId)).toHaveLength(0);
  });

  it('an elevated reviewer reveals the transcript with exactly one audit row (no vault)', async () => {
    const callId = 'test-rvreveal-transcript';
    const reviewId = await seedRevealable(callId);
    const session = await h.login({ elevated: true });
    const res = await postReveal(h, session, reviewId);
    expect(res.status).toBe(200);
    const body = res.json() as { raw_available: boolean; transcript: string };
    expect(body.raw_available).toBe(true);
    expect(body.transcript).toBe(RAW);

    const rows = await revealAudits(reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('reveal_raw');
    expect(rows[0]!.after).toMatchObject({ revealed: ['transcript'], call_id: callId });
  });

  it('reveals a single vault value; the audit records the token LABEL, never the plaintext', async () => {
    const callId = 'test-rvreveal-vault';
    const reviewId = await seedRevealable(callId);
    await h.seedVaultToken(callId, '[NAME_1]', 'Jane Doe');
    const session = await h.login({ elevated: true });

    const res = await postReveal(h, session, reviewId, '[NAME_1]');
    expect(res.status).toBe(200);
    const body = res.json() as { vault_value: string; vault_token_ref: string };
    expect(body.vault_value).toBe('Jane Doe');
    expect(body.vault_token_ref).toBe('[NAME_1]');

    const rows = await revealAudits(reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({
      revealed: ['transcript', 'vault_value'],
      call_id: callId,
      vault_token_ref: '[NAME_1]',
    });
    // The decrypted plaintext must NEVER appear in the audit row.
    expect(JSON.stringify(rows[0]!.after)).not.toContain('Jane Doe');
  });

  it('rejects a token that does not belong to this call (409)', async () => {
    const callId = 'test-rvreveal-other';
    const otherCall = 'test-rvreveal-othercall';
    const reviewId = await seedRevealable(callId);
    // Token exists only under a DIFFERENT call.
    await h.owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status) VALUES ($1,'test','redact','held') ON CONFLICT DO NOTHING`,
      [otherCall],
    );
    await h.seedVaultToken(otherCall, '[NAME_9]', 'Someone Else');
    const session = await h.login({ elevated: true });

    const res = await postReveal(h, session, reviewId, '[NAME_9]');
    expect(res.status).toBe(409);
    // No audit row written when the token is rejected.
    expect(await revealAudits(reviewId)).toHaveLength(0);
  });

  it('does not reveal when the review is concurrently resolved under a lock (no audit row)', async () => {
    const callId = 'test-rvreveal-race';
    const reviewId = await seedRevealable(callId);
    const session = await h.login({ elevated: true });

    // Hold the review row FOR UPDATE in a separate tx, resolve it, and commit while a reveal is in
    // flight. A correct reveal locks the review for the whole reveal+audit window, so it must wait
    // on this lock, observe the resolved status once released, and refuse — writing no audit row.
    const blocker = await h.owner.connect();
    let committed = false;
    let res: { status: number; json: () => unknown };
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM review_queue WHERE id = $1 FOR UPDATE`, [reviewId]);

      const revealP = postReveal(h, session, reviewId);
      // Give the reveal time to reach (and, when correct, block on) the review-row lock.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await blocker.query(
        `UPDATE review_queue SET status = 'resolved', resolved_at = now() WHERE id = $1`,
        [reviewId],
      );
      await blocker.query('COMMIT');
      committed = true;
      res = await revealP;
    } finally {
      // If an error hit before COMMIT, roll back so the pooled client isn't released mid-tx.
      if (!committed) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    // The review was terminal before reveal could commit — no raw revealed, no audit row.
    expect(res.status).toBe(409);
    expect(await revealAudits(reviewId)).toHaveLength(0);
  });

  it('returns raw_available:false with no audit row when raw is purged', async () => {
    const callId = 'test-rvreveal-purged';
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    // Seed raw while un-purged (Task 8.1's putTranscript guard blocks writing raw once the review
    // carries raw_purged_at), then stamp the purge flag: reveal must refuse on the flag alone.
    await h.seedRawTranscript(callId, RAW);
    await h.owner.query(`UPDATE review_queue SET raw_purged_at = $2 WHERE id = $1`, [
      reviewId,
      new Date('2026-07-03T11:00:00Z'),
    ]);
    const session = await h.login({ elevated: true });
    const res = await postReveal(h, session, reviewId);
    expect(res.status).toBe(200);
    expect((res.json() as { raw_available: boolean }).raw_available).toBe(false);
    expect(await revealAudits(reviewId)).toHaveLength(0);
  });
});
