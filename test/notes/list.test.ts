import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { login, type InternalHarness } from '../http/_helpers.js';
import { makeNotesHarness, postFeedback, seedNote } from './_harness.js';

/**
 * The paginated list: filters, pagination, the review-state three-way, and the parse-before-read
 * ordering that keeps a malformed query from ever reaching the database.
 */
const PATTERN = 'test-notes-list-%';

interface ListBody {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  filters: Record<string, string>;
  results: {
    call_id: string;
    review_state: string;
    urgency: string;
    service_category: string;
    dispatch_summary_first_line: string | null;
    not_established_count: number;
  }[];
  tally: { fields_checked: number; marked_right: number; note_prompt_version: string };
}

describe.skipIf(!hasTestDb)('note list', () => {
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

  const list = async (qs = ''): Promise<{ status: number; body: ListBody; raw: string }> => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/notes.json${qs}`,
      headers: { cookie: session.cookie, accept: 'application/json' },
    });
    return { status: res.statusCode, body: res.json<ListBody>(), raw: res.body };
  };

  const seedThree = async (): Promise<void> => {
    await seedNote(owner, app, {
      callId: 'test-notes-list-a',
      createdAt: '2026-07-10T12:00:00Z',
      serviceCategory: 'water_heater',
      urgency: 'emergency',
      dispatchSummary: 'Tank is leaking into the garage. Water shut off at the supply.',
      notEstablished: ['access_notes'],
    });
    await seedNote(owner, app, {
      callId: 'test-notes-list-b',
      createdAt: '2026-07-12T12:00:00Z',
      serviceCategory: 'drain_blockage',
      urgency: 'routine',
      dispatchSummary: 'Kitchen sink draining slowly.',
    });
    await seedNote(owner, app, {
      callId: 'test-notes-list-c',
      createdAt: '2026-07-14T12:00:00Z',
      serviceCategory: 'water_heater',
      urgency: 'routine',
      dispatchSummary: null,
    });
  };

  it('lists notes newest call first, with the summary reduced to its first line', async () => {
    await seedThree();
    const { body } = await list();
    expect(body.total).toBe(3);
    expect(body.results.map((r) => r.call_id)).toEqual([
      'test-notes-list-c',
      'test-notes-list-b',
      'test-notes-list-a',
    ]);
    // First LINE only: the technician's first impression is what the card judges.
    expect(body.results[2]?.dispatch_summary_first_line).toBe('Tank is leaking into the garage.');
    expect(body.results[0]?.dispatch_summary_first_line).toBeNull();
    expect(body.results[2]?.not_established_count).toBe(1);
  });

  it('filters by service category, urgency, and date range', async () => {
    await seedThree();
    expect((await list('?service_category=water_heater')).body.total).toBe(2);
    expect((await list('?urgency=emergency')).body.total).toBe(1);
    // Date-only bounds are inclusive of the named day on both ends.
    expect((await list('?from=2026-07-12&to=2026-07-12')).body.total).toBe(1);
    expect((await list('?from=2026-07-12')).body.total).toBe(2);
    expect((await list('?service_category=water_heater&urgency=routine')).body.total).toBe(1);
  });

  it('filters by review state, scoped to the note version', async () => {
    await seedThree();
    expect((await list('?review_state=unreviewed')).body.total).toBe(3);

    await postFeedback(h, session, 'test-notes-list-a', {
      field_path: 'occupancy',
      verdict: 'correct',
    });
    await postFeedback(h, session, 'test-notes-list-b', {
      field_path: 'occupancy',
      verdict: 'wrong',
    });

    expect((await list('?review_state=unreviewed')).body.total).toBe(1);
    expect((await list('?review_state=has_verdicts')).body.total).toBe(2);
    // Only the note with a NON-correct standing verdict.
    const wrong = await list('?review_state=has_wrong');
    expect(wrong.body.total).toBe(1);
    expect(wrong.body.results[0]?.call_id).toBe('test-notes-list-b');
    expect(wrong.body.results[0]?.review_state).toBe('has_wrong');
  });

  it('drops a note out of has_wrong once the reviewer revises to correct', async () => {
    await seedThree();
    await postFeedback(h, session, 'test-notes-list-b', {
      field_path: 'occupancy',
      verdict: 'wrong',
    });
    expect((await list('?review_state=has_wrong')).body.total).toBe(1);
    // The standing verdict is what counts — a superseded 'wrong' must not pin it there forever.
    await postFeedback(h, session, 'test-notes-list-b', {
      field_path: 'occupancy',
      verdict: 'correct',
    });
    expect((await list('?review_state=has_wrong')).body.total).toBe(0);
    expect((await list('?review_state=has_verdicts')).body.total).toBe(1);
  });

  it('paginates with a page total that agrees with the filtered set', async () => {
    await seedThree();
    const p1 = await list('?page_size=2');
    expect(p1.body).toMatchObject({ page: 1, page_size: 2, total: 3, total_pages: 2 });
    expect(p1.body.results).toHaveLength(2);
    const p2 = await list('?page_size=2&page=2');
    expect(p2.body.results).toHaveLength(1);
    // No row appears on both pages.
    const ids = [...p1.body.results, ...p2.body.results].map((r) => r.call_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('clamps page_size to the configured maximum', async () => {
    await seedThree();
    const clamped = await makeNotesHarness(app, { config: { NOTES_PAGE_SIZE_MAX: 2 } });
    const s = await login(clamped);
    const res = await clamped.app.inject({
      method: 'GET',
      url: '/notes.json?page_size=500',
      headers: { cookie: s.cookie, accept: 'application/json' },
    });
    expect(res.json<ListBody>().page_size).toBe(2);
  });

  it('hides a superseded duplicate call leg', async () => {
    await seedThree();
    await owner.query(
      `UPDATE structured_knowledge SET superseded_by_call_id = $1 WHERE call_id = $2`,
      ['test-notes-list-c', 'test-notes-list-b'],
    );
    const { body } = await list();
    expect(body.total).toBe(2);
    expect(body.results.map((r) => r.call_id)).not.toContain('test-notes-list-b');
  });

  it('rejects a malformed query BEFORE any database read', async () => {
    // A pool that throws if touched: this is what makes "before any DB read" an assertion rather
    // than a claim. If the route parsed lazily, the throw would surface as a 500, not a 400.
    const exploding = {
      query: () => {
        throw new Error('the database must not be reached for a malformed query');
      },
      connect: () => {
        throw new Error('the database must not be reached for a malformed query');
      },
    } as unknown as Pool;
    const hx = await makeNotesHarness(exploding);
    const s = await login(hx);

    for (const qs of [
      '?urgency=nope',
      '?review_state=whatever',
      '?from=not-a-date',
      '?from=2026-02-30',
      '?from=2026-07-14&to=2026-07-10',
      '?sentiment=positive',
      '?page=0',
    ]) {
      const res = await hx.app.inject({
        method: 'GET',
        url: `/notes.json${qs}`,
        headers: { cookie: s.cookie, accept: 'application/json' },
      });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json<{ error: string }>().error, qs).toBe('REQUEST_MALFORMED');
    }
  });

  it('echoes back only the filters that were set, and renders the HTML view', async () => {
    await seedThree();
    const { body } = await list('?urgency=routine&service_category=water_heater');
    expect(body.filters).toEqual({ urgency: 'routine', service_category: 'water_heater' });

    const html = await h.app.inject({
      method: 'GET',
      url: '/notes?urgency=routine',
      headers: { cookie: session.cookie },
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('Technician notes');
    expect(html.body).toContain('href="/notes/test-notes-list-c"');
  });

  it('says so plainly when nothing matches', async () => {
    const html = await h.app.inject({
      method: 'GET',
      url: '/notes',
      headers: { cookie: session.cookie },
    });
    expect(html.body).toContain('No technician notes match these filters.');
  });
});
