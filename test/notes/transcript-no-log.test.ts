import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { login, type InternalHarness } from '../http/_helpers.js';
import { makeNotesHarness, seedCleanTranscript, seedNote } from './_harness.js';

/**
 * The transcript response never reaches a log line.
 *
 * This surface is the only one that returns conversation text, so the log guard matters more here
 * than anywhere else: a request logger that echoed a response body would put a whole (redacted, but
 * still sensitive) transcript into the log store, outside the retention machinery that governs
 * `clean_transcripts`.
 *
 * A "the sentinel is absent from the logs" assertion is vacuous if nothing was logged at all, and
 * at the app's `warn` level a HEALTHY read logs nothing. So each test first proves the capture
 * channel is live by writing a probe line through the very logger the app holds, and asserts the
 * probe lands (carrying `call_id` — the traceability contract) before asserting the sentinel is
 * absent. Delete the guard in the route and the sentinel appears; silence the logger and the probe
 * assertion fails. Neither mutation passes.
 */
const PATTERN = 'test-notes-log-%';
const SENTINEL = 'pumpernickel-carburettor';

describe.skipIf(!hasTestDb)('transcript responses stay out of the logs', () => {
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
    h = await makeNotesHarness(app);
    session = await login(h);
  });

  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('logs neither the transcript body nor the note text', async () => {
    const callId = 'test-notes-log-1';
    const transcript = `Agent: hello\nCaller: the ${SENTINEL} is leaking badly`;
    await seedNote(owner, app, {
      callId,
      createdAt: '2026-07-15T12:00:00Z',
      symptomVerbatim: `the ${SENTINEL} is leaking`,
      dispatchSummary: `Leaking ${SENTINEL} in the garage.`,
    });
    await seedCleanTranscript(owner, callId, transcript);

    const tx = await h.app.inject({
      method: 'GET',
      url: `/notes/${callId}/transcript.json`,
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    expect(tx.statusCode).toBe(200);
    // Sanity: the sentinel really did travel in the response, so its absence from the logs below
    // is a statement about the logger and not about an empty response.
    expect(tx.body).toContain(SENTINEL);

    // Exercise the HTML pages too — they interpolate the same note text.
    await h.app.inject({
      method: 'GET',
      url: `/notes/${callId}`,
      headers: { cookie: session.cookie },
    });
    await h.app.inject({ method: 'GET', url: '/notes', headers: { cookie: session.cookie } });

    // Prove the capture channel is live before asserting an absence through it: a healthy read
    // logs nothing at `warn`, so without this the assertions below would pass on an empty array.
    h.logger.warn({ call_id: callId }, 'probe');
    expect(h.lines.join('\n'), 'capturing logger is not wired').toContain(callId);

    const logs = h.lines.join('\n');
    expect(logs, 'transcript sentinel reached a log line').not.toContain(SENTINEL);
    expect(logs, 'transcript body reached a log line').not.toContain('is leaking badly');
    expect(logs).not.toContain('redacted_text');
  });

  it('does not log the transcript on the withheld path either', async () => {
    // The withheld branch reads the row before deciding not to send it — the moment a well-meaning
    // "we withheld this, here is why" log line would be tempting to add.
    const callId = 'test-notes-log-2';
    await seedNote(owner, app, { callId, createdAt: '2026-07-15T12:00:00Z' });
    await seedCleanTranscript(owner, callId, `Caller: ${SENTINEL} — call 5551234567`);

    const res = await h.app.inject({
      method: 'GET',
      url: `/notes/${callId}/transcript.json`,
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    expect(res.json<{ reason: string }>().reason).toBe('withheld');

    h.logger.warn({ call_id: callId }, 'probe');
    const logs = h.lines.join('\n');
    expect(logs, 'capturing logger is not wired').toContain(callId);
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain('5551234567');
  });
});
