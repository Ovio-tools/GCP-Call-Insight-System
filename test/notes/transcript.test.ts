import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { login, type InternalHarness } from '../http/_helpers.js';
import { makeNotesHarness, seedCleanTranscript, seedNote } from './_harness.js';

/**
 * The transcript endpoint's three outcomes and its enumeration posture.
 *
 * It reads `getCleanTranscript` and nothing else. That repo's WHERE already excludes soft- and
 * hard-deleted rows, so absent / soft-deleted / hard-deleted collapse into one `undefined` — and
 * all of them, plus a call that does not exist at all, answer with the SAME 200 body. A 404 would
 * both dress up an ordinary retention outcome as a mistake and hand an enumerator a signal.
 */
const PATTERN = 'test-notes-tx-%';
const SPEECH = 'Agent: thanks for calling\nCaller: my water heater is cold';

interface TranscriptBody {
  available: boolean;
  reason?: string;
  redacted_text?: string;
}

describe.skipIf(!hasTestDb)('note transcript endpoint', () => {
  let owner!: Pool;
  let app!: Pool;
  let h!: InternalHarness;
  let session!: { cookie: string; csrfToken: string };

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });

  beforeEach(async () => {
    await cleanupCalls(owner, PATTERN);
    h = await makeNotesHarness(app, { denyTerms: ['Zephyrina Quux'] });
    session = await login(h);
  });

  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  const get = async (callId: string) =>
    h.app.inject({
      method: 'GET',
      url: `/notes/${encodeURIComponent(callId)}/transcript.json`,
      headers: { cookie: session.cookie, accept: 'application/json' },
    });

  it('returns the redacted text for a readable transcript', async () => {
    const callId = 'test-notes-tx-ok';
    await seedNote(owner, app, { callId, createdAt: '2026-07-15T12:00:00Z' });
    await seedCleanTranscript(owner, callId, SPEECH);

    const res = await get(callId);
    expect(res.statusCode).toBe(200);
    const body = res.json<TranscriptBody>();
    expect(body.available).toBe(true);
    expect(body.redacted_text).toBe(SPEECH);
    // The field is `redacted_text`, matching the column — never `text`/`transcript`/`body`, which
    // `assertNoContentFields` bans outright.
    expect(Object.keys(body).sort()).toEqual(['available', 'redacted_text']);
  });

  it('answers unavailable (200, not 404) for a SOFT-deleted transcript', async () => {
    const callId = 'test-notes-tx-soft';
    await seedNote(owner, app, { callId, createdAt: '2026-07-15T12:00:00Z' });
    await seedCleanTranscript(owner, callId, SPEECH, { softDeleted: true });

    const res = await get(callId);
    expect(res.statusCode).toBe(200);
    expect(res.json<TranscriptBody>()).toEqual({ available: false, reason: 'unavailable' });
    expect(res.body).not.toContain('water heater');
  });

  it('answers unavailable for a HARD-deleted transcript', async () => {
    const callId = 'test-notes-tx-hard';
    await seedNote(owner, app, { callId, createdAt: '2026-07-15T12:00:00Z' });
    await seedCleanTranscript(owner, callId, SPEECH, { hardDeleted: true });

    const res = await get(callId);
    expect(res.statusCode).toBe(200);
    expect(res.json<TranscriptBody>()).toEqual({ available: false, reason: 'unavailable' });
  });

  it('WITHHOLDS the whole body when residual PII is found — fail closed', async () => {
    const callId = 'test-notes-tx-pii';
    await seedNote(owner, app, { callId, createdAt: '2026-07-15T12:00:00Z' });
    // A deny-list name AND a digit run: either alone must be enough to withhold.
    const planted = `${SPEECH}\nCaller: this is Zephyrina Quux, call me on 5551234567`;
    await seedCleanTranscript(owner, callId, planted);

    const res = await get(callId);
    expect(res.statusCode).toBe(200);
    expect(res.json<TranscriptBody>()).toEqual({ available: false, reason: 'withheld' });
    // Not merely absent from the parsed body — absent from the PAYLOAD. A serializer that scrubbed
    // the offending phrase but shipped the rest would fail here, which is the point of failing
    // closed on the whole transcript rather than per field.
    expect(res.body).not.toContain('Zephyrina');
    expect(res.body).not.toContain('5551234567');
    expect(res.body).not.toContain('water heater');
  });

  it('distinguishes withheld from unavailable, so the UI can explain which happened', async () => {
    const withheldId = 'test-notes-tx-w2';
    const missingId = 'test-notes-tx-m2';
    await seedNote(owner, app, { callId: withheldId, createdAt: '2026-07-15T12:00:00Z' });
    await seedNote(owner, app, { callId: missingId, createdAt: '2026-07-15T12:00:00Z' });
    await seedCleanTranscript(owner, withheldId, 'Caller: reach me at 5551234567');

    expect(res_reason(await get(withheldId))).toBe('withheld');
    expect(res_reason(await get(missingId))).toBe('unavailable');
  });

  it('discloses nothing about which calls exist', async () => {
    const seeded = 'test-notes-tx-enum';
    await seedNote(owner, app, { callId: seeded, createdAt: '2026-07-15T12:00:00Z' });
    // Seeded call with no transcript, a call id that exists nowhere, and a hostile-looking id.
    const bodies = await Promise.all(
      [seeded, 'test-notes-tx-nope', "test-notes-tx-' OR 1=1--"].map(
        async (id) => (await get(id)).body,
      ),
    );
    expect(new Set(bodies).size, `responses differed: ${bodies.join(' | ')}`).toBe(1);
    expect(bodies[0]).toBe('{"available":false,"reason":"unavailable"}');
  });
});

function res_reason(res: { json: <T>() => T }): string | undefined {
  return res.json<TranscriptBody>().reason;
}
