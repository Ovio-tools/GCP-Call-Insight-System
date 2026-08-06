import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  NOTE_BOOLEAN_CORRECTED_VALUES,
  NOTE_BOOLEAN_FIELD_PATHS,
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_CORRECTABLE_VALUES,
  NOTE_EQUIPMENT_KEYS,
  NOTE_FEEDBACK_VERDICTS,
  NOTE_FIELD_PATHS,
  NOTE_OCCUPANCIES,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SCOPE_SIGNALS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
} from '../../src/db/enums.js';
import { hasTestDb, makePool, migrate } from './_pg.js';

/**
 * `enum-parity.test.ts` pins the NATIVE pg enums against `enum_range(...)`. The technician-note
 * vocabularies are `text` + CHECK instead, so `enum_range` does not apply — this extends the same
 * idea to CHECK constraints: read the live `pg_get_constraintdef`, pull out its quoted literals,
 * and compare against the `src/db/enums.ts` tuple the migration was hand-synced from.
 *
 * Without this, the two copies drift silently: the DB would accept a value the DAL rejects, or the
 * DAL would offer one the DB refuses, and neither shows up until a write fails in production.
 */
describe.skipIf(!hasTestDb)('technician-note vocabulary parity with the database', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function constraintDef(table: string, name: string): Promise<string> {
    const res = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname = $1 AND c.conname = $2`,
      [table, name],
    );
    const def = res.rows[0]?.def;
    // A renamed or dropped constraint must fail loudly rather than silently comparing nothing.
    expect(def, `constraint ${table}.${name} is missing`).toBeTruthy();
    return def!;
  }

  /** Every single-quoted literal in a constraint definition, de-duplicated, in first-seen order. */
  function literalsIn(def: string): string[] {
    const found = def.match(/'((?:[^']|'')*)'/g) ?? [];
    return [...new Set(found.map((m) => m.slice(1, -1).replace(/''/g, "'")))];
  }

  it('technician_notes.scope_signal CHECK matches NOTE_SCOPE_SIGNALS', async () => {
    const def = await constraintDef('technician_notes', 'technician_notes_scope_signal_chk');
    expect(literalsIn(def).sort()).toEqual([...NOTE_SCOPE_SIGNALS].sort());
  });

  it('technician_notes.occupancy CHECK matches NOTE_OCCUPANCIES', async () => {
    const def = await constraintDef('technician_notes', 'technician_notes_occupancy_chk');
    expect(literalsIn(def).sort()).toEqual([...NOTE_OCCUPANCIES].sort());
  });

  it('note_feedback.verdict CHECK matches NOTE_FEEDBACK_VERDICTS', async () => {
    const def = await constraintDef('note_feedback', 'note_feedback_verdict_chk');
    expect(literalsIn(def).sort()).toEqual([...NOTE_FEEDBACK_VERDICTS].sort());
  });

  it('note_feedback.field_path CHECK matches NOTE_FIELD_PATHS exactly', async () => {
    const def = await constraintDef('note_feedback', 'note_feedback_field_path_chk');
    expect(literalsIn(def).sort()).toEqual([...NOTE_FIELD_PATHS].sort());
  });

  it('the corrected-value CHECK carries exactly the union of NOTE_CORRECTABLE_VALUES', async () => {
    const def = await constraintDef('note_feedback', 'note_feedback_corrected_value_chk');
    // The constraint quotes both the correctable field paths and their allowed values.
    const expected = new Set<string>([
      ...Object.keys(NOTE_CORRECTABLE_VALUES),
      ...Object.values(NOTE_CORRECTABLE_VALUES).flatMap((v) => [...v]),
    ]);
    expect(literalsIn(def).sort()).toEqual([...expected].sort());
  });

  it('the corrected-value CHECK names every boolean field path and no other', async () => {
    const def = await constraintDef('note_feedback', 'note_feedback_corrected_value_chk');
    for (const path of NOTE_BOOLEAN_FIELD_PATHS) {
      expect(def, `boolean path ${path} missing from the CHECK`).toContain(`'${path}'`);
    }
    // Every free-text path must be ABSENT — its presence would mean a reviewer could type into it.
    const correctable = new Set<string>(Object.keys(NOTE_CORRECTABLE_VALUES));
    for (const path of NOTE_FIELD_PATHS) {
      if (correctable.has(path)) continue;
      expect(def, `free-text path ${path} must not appear in the CHECK`).not.toContain(`'${path}'`);
    }
  });

  it('NOTE_CORRECTABLE_VALUES covers scope_signal, occupancy, and the 16 boolean paths only', () => {
    expect(Object.keys(NOTE_CORRECTABLE_VALUES).sort()).toEqual(
      ['scope_signal', 'occupancy', ...NOTE_BOOLEAN_FIELD_PATHS].sort(),
    );
    for (const path of NOTE_BOOLEAN_FIELD_PATHS) {
      expect(NOTE_CORRECTABLE_VALUES[path]).toEqual(NOTE_BOOLEAN_CORRECTED_VALUES);
    }
  });

  it('every jsonb object key has a matching dotted field path, and vice versa', () => {
    // Keeps the note SHAPE and the feedback ADDRESS SPACE from drifting: a key added to a jsonb
    // object with no field path is a field no reviewer can grade, and a dotted path with no key
    // is an address that grades nothing.
    const groups: Record<string, readonly string[]> = {
      equipment: NOTE_EQUIPMENT_KEYS,
      system_context: NOTE_SYSTEM_CONTEXT_KEYS,
      water_status: NOTE_WATER_STATUS_KEYS,
      payer_authority: NOTE_PAYER_AUTHORITY_KEYS,
      prior_work: NOTE_PRIOR_WORK_KEYS,
      commitments_made: NOTE_COMMITMENTS_MADE_KEYS,
    };
    const fromKeys = Object.entries(groups)
      .flatMap(([group, keys]) => keys.map((k) => `${group}.${k}`))
      .sort();
    const fromPaths = NOTE_FIELD_PATHS.filter((p) => p.includes('.')).sort();
    expect(fromPaths).toEqual(fromKeys);
  });

  it('every boolean-group key is a boolean field path (and no string-group key is)', () => {
    const booleanGroups = [
      ['water_status', NOTE_WATER_STATUS_KEYS],
      ['payer_authority', NOTE_PAYER_AUTHORITY_KEYS],
      ['prior_work', NOTE_PRIOR_WORK_KEYS],
      ['commitments_made', NOTE_COMMITMENTS_MADE_KEYS],
    ] as const;
    const expected = booleanGroups
      .flatMap(([group, keys]) => keys.map((k) => `${group}.${k}`))
      .sort();
    expect([...NOTE_BOOLEAN_FIELD_PATHS].sort()).toEqual(expected);
  });
});
