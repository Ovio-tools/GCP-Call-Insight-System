import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { login, type InternalHarness } from '../http/_helpers.js';
import { makeNotesHarness, postFeedback, seedNote } from './_harness.js';

/**
 * The feedback POST: validation, immutability of the note under judgement, and the append-only
 * supersede semantics.
 *
 * `note_feedback` is the labeled corpus a future prompt version will be measured against, so two
 * properties are load-bearing: a verdict never edits the artifact it judges, and a verdict is
 * always attributable to the note version it was given against.
 */
const PATTERN = 'test-notes-fb-%';
const CALL = 'test-notes-fb-1';

interface FeedbackResponse {
  verdict: { field_path: string; verdict: string; corrected_enum_value: string | null };
  tally: { fields_checked: number; marked_right: number; note_prompt_version: string };
}

describe.skipIf(!hasTestDb)('note feedback POST', () => {
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
    await seedNote(owner, app, {
      callId: CALL,
      createdAt: '2026-07-15T12:00:00Z',
      promptVersion: 'tech-note-v1',
      dispatchSummary: 'Tank water heater, no hot water.',
      accessNotes: 'side gate unlocked',
    });
  });

  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  const feedbackCount = async (): Promise<number> => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM note_feedback WHERE call_id LIKE $1`,
      [PATTERN],
    );
    return Number(r.rows[0]?.n ?? '0');
  };

  describe('validation', () => {
    /** Every rejection must leave the store untouched, so each case asserts the count as well. */
    const expectRejected = async (body: unknown): Promise<void> => {
      const res = await postFeedback(h, session, CALL, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('REQUEST_MALFORMED');
      expect(await feedbackCount(), 'a rejected verdict was written anyway').toBe(0);
    };

    it('rejects an off-vocabulary field_path', async () => {
      await expectRejected({ field_path: 'equipment.colour', verdict: 'correct' });
      await expectRejected({ field_path: 'dispatch_summary; DROP TABLE', verdict: 'correct' });
    });

    it('rejects an off-vocabulary verdict', async () => {
      await expectRejected({ field_path: 'occupancy', verdict: 'lgtm' });
    });

    it('rejects an off-vocabulary corrected value for a controlled field', async () => {
      await expectRejected({
        field_path: 'occupancy',
        verdict: 'wrong',
        corrected_enum_value: 'landlord',
      });
      await expectRejected({
        field_path: 'water_status.supply_shut_off',
        verdict: 'wrong',
        corrected_enum_value: 'maybe',
      });
    });

    it('rejects ANY corrected value on a free-text field — no reviewer prose, ever', async () => {
      // The 18 free-text paths admit no correction at all. A reviewer may mark them wrong but may
      // not retype them; that absence is what keeps prose out of `note_feedback`.
      await expectRejected({
        field_path: 'access_notes',
        verdict: 'wrong',
        corrected_enum_value: 'the gate code is 4417',
      });
      await expectRejected({
        field_path: 'dispatch_summary',
        verdict: 'wrong',
        corrected_enum_value: 'should have said the customer is Jane Doe',
      });
    });

    it('rejects a client-supplied note_prompt_version', async () => {
      // `.strict()` — the server takes the version from the note, so a verdict cannot be
      // mis-attributed to a version it was not given against.
      await expectRejected({
        field_path: 'occupancy',
        verdict: 'correct',
        note_prompt_version: 'tech-note-v99',
      });
    });

    it('rejects a verdict on a call that has no note, without disclosing that fact', async () => {
      const res = await postFeedback(h, session, 'test-notes-fb-absent', {
        field_path: 'occupancy',
        verdict: 'correct',
      });
      expect(res.status).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('REQUEST_MALFORMED');
      // Identical to an off-vocabulary rejection, so a POST cannot be used to probe for calls.
      const offVocab = await postFeedback(h, session, CALL, {
        field_path: 'nope',
        verdict: 'correct',
      });
      const shape = (b: string): string => b.replace(/"request_id":"[^"]*"/, '"request_id":"…"');
      expect(shape(res.body)).toBe(shape(offVocab.body));
    });

    it('accepts a valid corrected value for a controlled field', async () => {
      // The counterweight: without this, a handler that rejected EVERYTHING would pass above.
      const res = await postFeedback(h, session, CALL, {
        field_path: 'occupancy',
        verdict: 'wrong',
        corrected_enum_value: 'tenant',
      });
      expect(res.status).toBe(200);
      expect(res.json<FeedbackResponse>().verdict.corrected_enum_value).toBe('tenant');
    });
  });

  describe('immutability of the note under judgement', () => {
    it('leaves the technician_notes row unchanged, column by column', async () => {
      const snapshot = async (): Promise<Record<string, unknown>> => {
        const r = await owner.query<Record<string, unknown>>(
          `SELECT * FROM technician_notes WHERE call_id = $1`,
          [CALL],
        );
        return r.rows[0]!;
      };

      const before = await snapshot();
      // Column-by-column, not a whole-row deep-equal: a future `SELECT` shape change would silently
      // shrink a deep-equal into a weaker assertion, and the column list is the thing being claimed.
      expect(Object.keys(before).length).toBeGreaterThan(20);

      for (const body of [
        { field_path: 'dispatch_summary', verdict: 'wrong' },
        { field_path: 'occupancy', verdict: 'wrong', corrected_enum_value: 'tenant' },
        { field_path: 'access_notes', verdict: 'should_not_be_here' },
        { field_path: 'not_established', verdict: 'missing' },
      ]) {
        expect((await postFeedback(h, session, CALL, body)).status, JSON.stringify(body)).toBe(200);
      }

      const after = await snapshot();
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      for (const column of Object.keys(before)) {
        expect(after[column], `technician_notes.${column} changed`).toEqual(before[column]);
      }
      // And the verdicts really were recorded — otherwise "unchanged" is trivially true.
      expect(await feedbackCount()).toBe(4);
    });
  });

  describe('append-only supersede semantics', () => {
    it('supersedes at read time while BOTH rows persist', async () => {
      const first = await postFeedback(h, session, CALL, {
        field_path: 'occupancy',
        verdict: 'wrong',
        corrected_enum_value: 'tenant',
      });
      expect(first.status).toBe(200);
      const second = await postFeedback(h, session, CALL, {
        field_path: 'occupancy',
        verdict: 'correct',
      });
      expect(second.status).toBe(200);

      // Both rows are still there — a revision is an insert, never an update.
      const rows = await owner.query<{ verdict: string; corrected_enum_value: string | null }>(
        `SELECT verdict, corrected_enum_value FROM note_feedback
          WHERE call_id = $1 AND field_path = 'occupancy' ORDER BY created_at, id`,
        [CALL],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.map((r) => r.verdict)).toEqual(['wrong', 'correct']);

      // The LATER one stands at read time.
      expect(second.json<FeedbackResponse>().verdict.verdict).toBe('correct');
      const detail = await h.app.inject({
        method: 'GET',
        url: `/notes/${CALL}.json`,
        headers: { cookie: session.cookie, accept: 'application/json' },
      });
      const verdicts = detail.json<{ verdicts: { field_path: string; verdict: string }[] }>()
        .verdicts;
      expect(verdicts.filter((v) => v.field_path === 'occupancy')).toEqual([
        { field_path: 'occupancy', verdict: 'correct', corrected_enum_value: null },
      ]);
    });

    it('stamps the verdict with the NOTE’s prompt version', async () => {
      const other = 'test-notes-fb-v2';
      await seedNote(owner, app, {
        callId: other,
        createdAt: '2026-07-15T12:00:00Z',
        promptVersion: 'tech-note-v2',
      });
      await postFeedback(h, session, other, { field_path: 'occupancy', verdict: 'correct' });

      const r = await owner.query<{ note_prompt_version: string }>(
        `SELECT note_prompt_version FROM note_feedback WHERE call_id = $1`,
        [other],
      );
      expect(r.rows[0]?.note_prompt_version).toBe('tech-note-v2');
    });

    it('returns the refreshed tally so the page updates without a reload', async () => {
      const a = await postFeedback(h, session, CALL, {
        field_path: 'occupancy',
        verdict: 'correct',
      });
      expect(a.json<FeedbackResponse>().tally).toMatchObject({
        fields_checked: 1,
        marked_right: 1,
        note_prompt_version: 'tech-note-v1',
      });

      const b = await postFeedback(h, session, CALL, {
        field_path: 'access_notes',
        verdict: 'wrong',
      });
      expect(b.json<FeedbackResponse>().tally).toMatchObject({
        fields_checked: 2,
        marked_right: 1,
      });

      // A REVISION counts once, at its latest value — not twice.
      const c = await postFeedback(h, session, CALL, {
        field_path: 'access_notes',
        verdict: 'correct',
      });
      expect(c.json<FeedbackResponse>().tally).toMatchObject({
        fields_checked: 2,
        marked_right: 2,
      });
    });
  });
});
