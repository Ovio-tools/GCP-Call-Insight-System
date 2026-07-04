import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, migrate } from '../db/_pg.js';
import { makeReviewHarness, postAction, type ReviewHarness } from './_harness.js';

const PATTERN = 'test-rvpriv-%';

// Distinctive sentinels that must NEVER reach an unauthorized/standard-reviewer response, a log
// line, an error body, or an operator_actions row.
const RAW_PHONE = '5559998888';
const VAULT_NAME = 'Zephyrina Quux';

describe.skipIf(!hasTestDb)('review surface privacy (Task 6.2)', () => {
  let h!: ReviewHarness;
  beforeAll(async () => {
    await migrate('up');
    h = await makeReviewHarness();
  });
  afterEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  async function seedSensitive(callId: string): Promise<string> {
    const reviewId = await h.seedHeld(callId, { reason: 'redaction_failed', stage: 'redact' });
    await h.seedRawTranscript(callId, `caller phone ${RAW_PHONE} said the heater failed`);
    await h.seedVaultToken(callId, '[NAME_1]', VAULT_NAME);
    await h.seedCleanTranscript(callId, 'Customer [NAME_1] reported a broken heater.');
    return reviewId;
  }

  it('an unauthenticated detail request leaks no PII', async () => {
    const callId = 'test-rvpriv-unauth';
    const reviewId = await seedSensitive(callId);
    const res = await h.app.inject({ method: 'GET', url: `/review/${reviewId}.json` });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(RAW_PHONE);
    expect(res.body).not.toContain(VAULT_NAME);
  });

  it('a standard-reviewer detail response carries only redacted content — no raw/vault PII', async () => {
    const callId = 'test-rvpriv-std';
    const reviewId = await seedSensitive(callId);
    const session = await h.login({ elevated: false });
    const res = await h.app.inject({
      method: 'GET',
      url: `/review/${reviewId}.json`,
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(RAW_PHONE);
    expect(res.body).not.toContain(VAULT_NAME);
    // The redacted token IS present (it is safe).
    expect(res.body).toContain('[NAME_1]');
  });

  it('a standard reviewer cannot reveal raw (403) and no raw is disclosed', async () => {
    const callId = 'test-rvpriv-noreveal';
    const reviewId = await seedSensitive(callId);
    const session = await h.login({ elevated: false });
    const res = await h.app.inject({
      method: 'POST',
      url: `/review/${reviewId}/reveal-raw`,
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(RAW_PHONE);
    expect(res.body).not.toContain(VAULT_NAME);
  });

  it('an action audit row carries no PII, and no PII reaches the logs', async () => {
    const callId = 'test-rvpriv-audit';
    const reviewId = await seedSensitive(callId);
    const session = await h.login();
    expect((await postAction(h, session, reviewId, 'reject')).status).toBe(200);

    const audit = await h.owner.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM operator_actions WHERE review_queue_id=$1`,
      [reviewId],
    );
    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain(RAW_PHONE);
    expect(serialized).not.toContain(VAULT_NAME);

    const logs = h.lines.join('\n');
    expect(logs).not.toContain(RAW_PHONE);
    expect(logs).not.toContain(VAULT_NAME);
  });
});
