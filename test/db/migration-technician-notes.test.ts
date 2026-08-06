import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  NOTE_BOOLEAN_FIELD_PATHS,
  NOTE_FEEDBACK_VERDICTS,
  NOTE_FIELD_PATHS,
  NOTE_OCCUPANCIES,
  NOTE_SCOPE_SIGNALS,
} from '../../src/db/enums.js';
import { DISPATCH_SUMMARY_MAX_LENGTH } from '../../src/db/schemas/technician-notes.js';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { makeAppPool } from './_dal.js';

/**
 * Migration `1782864100005` — `technician_notes` + `note_feedback` (ADR 0009).
 *
 * Pins the table shapes, the complete-key-set jsonb defaults, every CHECK vocabulary, the
 * per-field-path `corrected_enum_value` rule, the CASCADE FKs, the grants (app_role never DELETEs;
 * note_feedback is INSERT-only), and a clean, non-destructive down.
 */
describe.skipIf(!hasTestDb)('migration 1782864100005 — technician_notes + note_feedback', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALL = 'tn005-call';
  const PRE_EXISTING = 'tn005-pre-existing';

  const NOTE_COLS = '(call_id, prompt_version, model_id, schema_version, scope_signal, occupancy)';
  const NOTE_VALS = "($1, 'note-v1', 'model-x', 1, 'single_fixture', 'owner')";

  async function seedCall(callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status)
       VALUES ($1, 'test', 'store', 'completed') ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  async function seedNote(callId: string): Promise<void> {
    await owner.query(
      `INSERT INTO technician_notes ${NOTE_COLS} VALUES ${NOTE_VALS}
       ON CONFLICT (call_id) DO NOTHING`,
      [callId],
    );
  }

  /** Insert one feedback row, returning the promise so callers can assert resolve/reject.
   * `actor` is overridable so a test that COUNTS rows can scope itself to its own reviewer —
   * the table is append-only and shared across cases in this file, so nothing is cleaned between
   * them. */
  function insertFeedback(
    pool: Pool,
    callId: string,
    fieldPath: string,
    verdict: string,
    correctedEnumValue: string | null = null,
    actor = 'tn005-reviewer',
  ): Promise<unknown> {
    return pool.query(
      `INSERT INTO note_feedback
         (call_id, note_prompt_version, reviewer_actor, field_path, verdict, corrected_enum_value)
       VALUES ($1, 'note-v1', $5, $2, $3, $4)`,
      [callId, fieldPath, verdict, correctedEnumValue, actor],
    );
  }

  async function cleanup(): Promise<void> {
    // Both tables CASCADE from call_state, so deleting the parent is enough — which is itself
    // the behaviour `cascades ...` below asserts.
    await owner.query(`DELETE FROM call_state WHERE call_id LIKE 'tn005-%'`);
  }

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('applies against a database that already has call_state rows', async () => {
    // The migration ran in beforeAll against a DB carrying real rows from every sibling suite;
    // seed one more explicitly and confirm the new tables accept it. The tables are additive —
    // no backfill, no rewrite of an existing row — so an existing corpus is untouched.
    await seedCall(PRE_EXISTING);
    await seedNote(PRE_EXISTING);
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM technician_notes WHERE call_id = $1`,
      [PRE_EXISTING],
    );
    expect(res.rows[0]!.n).toBe(1);
  });

  it('defaults every jsonb object to a COMPLETE key set of nulls, and lists to []', async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    const res = await owner.query<{
      equipment: Record<string, unknown>;
      system_context: Record<string, unknown>;
      water_status: Record<string, unknown>;
      payer_authority: Record<string, unknown>;
      prior_work: Record<string, unknown>;
      commitments_made: Record<string, unknown>;
      hazards: unknown[];
      urgency_context: unknown[];
      not_established: unknown[];
    }>(`SELECT * FROM technician_notes WHERE call_id = $1`, [CALL]);
    const row = res.rows[0]!;

    // A complete key set is what lets the strict row schema parse a default-constructed row, and
    // what distinguishes "never established" from "not a field we track".
    expect(Object.keys(row.equipment).sort()).toEqual(
      ['approximate_age', 'brand', 'capacity', 'fuel_type', 'model', 'type'].sort(),
    );
    expect(Object.keys(row.water_status)).toHaveLength(4);
    expect(Object.keys(row.payer_authority)).toHaveLength(4);
    expect(Object.keys(row.prior_work)).toHaveLength(3);
    expect(Object.keys(row.system_context)).toHaveLength(4);
    expect(Object.keys(row.commitments_made)).toHaveLength(5);
    expect(Object.values(row.equipment).every((v) => v === null)).toBe(true);
    expect(Object.values(row.commitments_made).every((v) => v === null)).toBe(true);

    expect(row.hazards).toEqual([]);
    expect(row.urgency_context).toEqual([]);
    expect(row.not_established).toEqual([]);
  });

  it(`accepts a ${DISPATCH_SUMMARY_MAX_LENGTH}-character dispatch_summary`, async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    await expect(
      owner.query(`UPDATE technician_notes SET dispatch_summary = $2 WHERE call_id = $1`, [
        CALL,
        'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH),
      ]),
    ).resolves.toBeDefined();
  });

  it(`rejects a ${DISPATCH_SUMMARY_MAX_LENGTH + 1}-character dispatch_summary`, async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    await expect(
      owner.query(`UPDATE technician_notes SET dispatch_summary = $2 WHERE call_id = $1`, [
        CALL,
        'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH + 1),
      ]),
    ).rejects.toThrow(/dispatch_summary_len_chk|violates check constraint/i);
  });

  it('rejects an off-vocabulary scope_signal and occupancy', async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    await expect(
      owner.query(`UPDATE technician_notes SET scope_signal = 'bogus' WHERE call_id = $1`, [CALL]),
    ).rejects.toThrow(/scope_signal_chk|violates check constraint/i);
    await expect(
      owner.query(`UPDATE technician_notes SET occupancy = 'bogus' WHERE call_id = $1`, [CALL]),
    ).rejects.toThrow(/occupancy_chk|violates check constraint/i);
  });

  it('accepts every scope_signal and occupancy in the vocabulary', async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    for (const scope of NOTE_SCOPE_SIGNALS) {
      await expect(
        owner.query(`UPDATE technician_notes SET scope_signal = $2 WHERE call_id = $1`, [
          CALL,
          scope,
        ]),
      ).resolves.toBeDefined();
    }
    for (const occ of NOTE_OCCUPANCIES) {
      await expect(
        owner.query(`UPDATE technician_notes SET occupancy = $2 WHERE call_id = $1`, [CALL, occ]),
      ).resolves.toBeDefined();
    }
  });

  it('rejects an off-vocabulary field_path and verdict', async () => {
    await seedCall(CALL);
    await expect(insertFeedback(owner, CALL, 'not_a_field', 'correct')).rejects.toThrow(
      /field_path_chk|violates check constraint/i,
    );
    await expect(insertFeedback(owner, CALL, 'occupancy', 'sort_of')).rejects.toThrow(
      /verdict_chk|violates check constraint/i,
    );
  });

  it('accepts every field_path and every verdict in the vocabulary', async () => {
    await seedCall(CALL);
    for (const path of NOTE_FIELD_PATHS) {
      await expect(insertFeedback(owner, CALL, path, 'wrong')).resolves.toBeDefined();
    }
    for (const verdict of NOTE_FEEDBACK_VERDICTS) {
      await expect(insertFeedback(owner, CALL, 'occupancy', verdict)).resolves.toBeDefined();
    }
  });

  it('allows a corrected value only from that field_path’s own controlled list', async () => {
    await seedCall(CALL);
    // In-vocabulary for its own path.
    await expect(
      insertFeedback(owner, CALL, 'occupancy', 'wrong', 'tenant'),
    ).resolves.toBeDefined();
    await expect(
      insertFeedback(owner, CALL, 'scope_signal', 'wrong', 'whole_property'),
    ).resolves.toBeDefined();
    await expect(
      insertFeedback(owner, CALL, NOTE_BOOLEAN_FIELD_PATHS[0], 'wrong', 'true'),
    ).resolves.toBeDefined();

    // A value that is valid — but for a DIFFERENT path. The per-path rule is what catches this;
    // a single flat allowlist would let it through.
    await expect(
      insertFeedback(owner, CALL, 'occupancy', 'wrong', 'whole_property'),
    ).rejects.toThrow(/corrected_value_chk|violates check constraint/i);
    await expect(insertFeedback(owner, CALL, 'scope_signal', 'wrong', 'tenant')).rejects.toThrow(
      /corrected_value_chk|violates check constraint/i,
    );
    await expect(
      insertFeedback(owner, CALL, NOTE_BOOLEAN_FIELD_PATHS[0], 'wrong', 'unknown'),
    ).rejects.toThrow(/corrected_value_chk|violates check constraint/i);
  });

  it('admits NO corrected value on a free-text field_path (the no-prose guarantee)', async () => {
    await seedCall(CALL);
    for (const path of ['access_notes', 'symptom_verbatim', 'equipment.brand', 'hazards']) {
      // A verdict alone is always fine...
      await expect(insertFeedback(owner, CALL, path, 'wrong')).resolves.toBeDefined();
      // ...but anything typed alongside it is refused by the database itself.
      await expect(
        insertFeedback(owner, CALL, path, 'wrong', 'Mrs Alvarez on Beech St'),
      ).rejects.toThrow(/corrected_value_chk|violates check constraint/i);
    }
  });

  it('is append-only: a revised verdict inserts a second row rather than conflicting', async () => {
    await seedCall(CALL);
    const actor = 'tn005-revisionist';
    await insertFeedback(owner, CALL, 'occupancy', 'wrong', 'tenant', actor);
    // No UNIQUE blocks the second write on the same (call, field, reviewer, version) key —
    // a reviewer changing their mind must be recordable.
    await expect(
      insertFeedback(owner, CALL, 'occupancy', 'correct', null, actor),
    ).resolves.toBeDefined();
    const res = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM note_feedback
        WHERE call_id = $1 AND field_path = 'occupancy' AND reviewer_actor = $2`,
      [CALL, actor],
    );
    expect(res.rows[0]!.n).toBe(2);
  });

  it('cascades to both tables when the call_state row is deleted', async () => {
    await seedCall(CALL);
    await seedNote(CALL);
    await insertFeedback(owner, CALL, 'occupancy', 'correct');

    const before = await owner.query<{ notes: number; feedback: number }>(
      `SELECT (SELECT count(*)::int FROM technician_notes WHERE call_id = $1) AS notes,
              (SELECT count(*)::int FROM note_feedback   WHERE call_id = $1) AS feedback`,
      [CALL],
    );
    expect(before.rows[0]!.notes).toBe(1);
    expect(before.rows[0]!.feedback).toBeGreaterThan(0);

    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [CALL]);

    const after = await owner.query<{ notes: number; feedback: number }>(
      `SELECT (SELECT count(*)::int FROM technician_notes WHERE call_id = $1) AS notes,
              (SELECT count(*)::int FROM note_feedback   WHERE call_id = $1) AS feedback`,
      [CALL],
    );
    expect(after.rows[0]!.notes).toBe(0);
    expect(after.rows[0]!.feedback).toBe(0);
  });

  it('grants app_role SELECT/INSERT/UPDATE on technician_notes but never DELETE', async () => {
    await seedCall(CALL);
    await expect(
      app.query(
        `INSERT INTO technician_notes ${NOTE_COLS} VALUES ${NOTE_VALS}
         ON CONFLICT (call_id) DO NOTHING`,
        [CALL],
      ),
    ).resolves.toBeDefined();
    await expect(
      app.query(`SELECT call_id FROM technician_notes WHERE call_id = $1`, [CALL]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`UPDATE technician_notes SET scope_signal = 'whole_property' WHERE call_id = $1`, [
        CALL,
      ]),
    ).resolves.toBeDefined();
    await expect(
      app.query(`DELETE FROM technician_notes WHERE call_id = $1`, [CALL]),
    ).rejects.toThrow();
  });

  it('grants app_role SELECT/INSERT on note_feedback but never UPDATE or DELETE', async () => {
    await seedCall(CALL);
    await expect(insertFeedback(app, CALL, 'occupancy', 'correct')).resolves.toBeDefined();
    await expect(
      app.query(`SELECT id FROM note_feedback WHERE call_id = $1`, [CALL]),
    ).resolves.toBeDefined();
    // Append-only is enforced by the GRANT, not just by convention.
    await expect(
      app.query(`UPDATE note_feedback SET verdict = 'wrong' WHERE call_id = $1`, [CALL]),
    ).rejects.toThrow();
    await expect(
      app.query(`DELETE FROM note_feedback WHERE call_id = $1`, [CALL]),
    ).rejects.toThrow();
  });

  it('has the latest-verdict-wins index', async () => {
    const res = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'note_feedback'`,
    );
    const defs = res.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/call_id.*field_path.*reviewer_actor.*note_prompt_version/s);
  });

  describe('down migration', () => {
    /** Fingerprint of structured_knowledge alone — columns + constraints, fully defined. */
    async function structuredKnowledgeFingerprint(): Promise<string> {
      const columns = await owner.query<Record<string, string | null>>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'structured_knowledge'
          ORDER BY column_name`,
      );
      const constraints = await owner.query<Record<string, string>>(
        `SELECT c.conname, c.contype::text AS contype, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class rel ON rel.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = 'public' AND rel.relname = 'structured_knowledge'
          ORDER BY c.conname`,
      );
      return JSON.stringify({ columns: columns.rows, constraints: constraints.rows });
    }

    it('drops both tables and leaves structured_knowledge byte-identical', async () => {
      await cleanup();
      const before = await structuredKnowledgeFingerprint();

      await migrate('down', 1);

      const gone = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('technician_notes', 'note_feedback')`,
      );
      expect(gone.rows[0]!.n).toBe(0);

      // The durable store this one sits beside must be untouched by the rollback — the point of
      // the assertion is that `down` is non-destructive to everything it did not create.
      expect(await structuredKnowledgeFingerprint()).toBe(before);

      await migrate('up');
      expect(await structuredKnowledgeFingerprint()).toBe(before);
    });
  });
});
