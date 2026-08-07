import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { login, type InternalHarness } from '../http/_helpers.js';
import { makeNotesHarness, seedCleanTranscript, seedNote } from './_harness.js';
import { repositories } from '../../src/db/index.js';

/**
 * A call with no technician note is an ordinary outcome, not a failure: the generator counts a
 * missing/soft-deleted/hard-deleted clean transcript as a SKIP, so plenty of real calls will never
 * have one. The detail view must explain that rather than return an error the reader did nothing
 * to cause.
 */
const PATTERN = 'test-notes-none-%';

describe.skipIf(!hasTestDb)('a call with no note', () => {
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

  it('renders an explanation, not an error, for a real call that was never noted', async () => {
    const callId = 'test-notes-none-real';
    // A genuine call that reached the pipeline but has no note — the common shape.
    await repositories.callState.upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'store',
      status: 'completed',
    });
    await seedCleanTranscript(owner, callId, 'Agent: hello\nCaller: hello');

    const res = await h.app.inject({
      method: 'GET',
      url: `/notes/${callId}`,
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('No note for this call');
    expect(res.body).toContain('there is nothing to review here');
    // A way back, so the reader is not stranded.
    expect(res.body).toContain('href="/notes"');
  });

  it('renders the same explanation for a call id that does not exist at all', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/notes/test-notes-none-absent',
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No note for this call');
  });

  it('answers the JSON twin without disclosing whether the call exists', async () => {
    const real = 'test-notes-none-real2';
    await repositories.callState.upsertCallState(app, {
      callId: real,
      source: 'test',
      currentStage: 'store',
      status: 'completed',
    });

    const [existing, absent] = await Promise.all(
      [real, 'test-notes-none-absent2'].map(async (id) =>
        h.app.inject({
          method: 'GET',
          url: `/notes/${id}.json`,
          headers: { cookie: session.cookie, accept: 'application/json' },
        }),
      ),
    );
    expect(existing!.statusCode).toBe(200);
    expect(existing!.body).toBe(absent!.body);
    expect(existing!.json<{ available: boolean }>().available).toBe(false);
  });

  it('still serves a note when one exists — the counterweight', async () => {
    // Without this, a handler that reported "no note" for everything would pass the tests above.
    const callId = 'test-notes-none-has';
    await seedNote(owner, app, {
      callId,
      createdAt: '2026-07-15T12:00:00Z',
      dispatchSummary: 'Tank water heater, no hot water.',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: `/notes/${callId}`,
      headers: { cookie: session.cookie },
    });
    expect(res.body).not.toContain('No note for this call');
    expect(res.body).toContain('Tank water heater, no hot water.');
    expect(res.body).toContain('What the technician receives');
  });
});
