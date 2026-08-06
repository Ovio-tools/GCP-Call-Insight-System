'use strict';

/**
 * Technician notes + note feedback — the job-readiness layer over the call summary (ADR 0009).
 *
 * `structured_knowledge` says what a call was ABOUT. Neither it nor the general summary tells a
 * plumbing technician what they need in order to roll a truck: which equipment is involved, whether
 * water is still running right now, who can actually approve the work, what was already promised on
 * the phone, and — just as important — what was never established. Two tables:
 *
 *  - `technician_notes` — ONE current note per call (PK call_id), regenerated in place by a later
 *    model stage. De-identified derived knowledge, in the same class as `structured_knowledge`:
 *    NO raw transcript text, NO vault values. Lives in DB-A.
 *  - `note_feedback` — APPEND-ONLY reviewer verdicts on individual note fields, so note quality can
 *    be measured over time. No unique constraint: a reviewer must be able to revise a verdict, and
 *    the latest row per (call_id, field_path, reviewer_actor, note_prompt_version) wins at read
 *    time. There is deliberately NO free-text column — see below.
 *
 * NOT PURGED (ADR 0009). `technician_notes` joins `structured_knowledge` as a durable store and is
 * registered with NO retention group; `test/db/technician-notes-no-purge-group.test.ts` pins that
 * both as a source guard over `src/retention/purge.ts` and as a dry-run assertion. It nonetheless
 * carries the `retention_eligible_at`/`soft_deleted_at`/`hard_deleted_at` triplet and pre-provisioned
 * purge_role grants, so if that policy is ever revisited the change is a one-line registration in
 * the cron rather than a schema migration against a populated table. `note_feedback` holds only
 * field paths, verdicts, and controlled enum values — no retention bookkeeping, nothing to purge.
 *
 * Retention columns are spread from `lib/columns.cjs` directly and `PURGEABLE_TABLES` there is NOT
 * appended to — migration 5's purge grants consume that list at migration time, so appending would
 * change what a FRESH run of migration 5 grants and diverge from an already-migrated database
 * (the hazard migration 9 documents).
 *
 * NO FREE TEXT ON FEEDBACK. `note_feedback.corrected_enum_value` is constrained per `field_path`:
 * `scope_signal` and `occupancy` accept only their own vocabularies, the sixteen boolean paths
 * accept only 'true'/'false', and every free-text path (a brand, a symptom in the caller's words,
 * an access note) admits NO correction value at all. A reviewer may mark such a field wrong but may
 * not retype it. Same reasoning as `src/review/correction-constants.ts`: residual PII scanning is
 * not a complete guarantee, so reviewer prose never enters the system. Enforcing it in the DB — not
 * just in zod — means a raw-SQL writer cannot smuggle prose in either.
 *
 * The `corrected_enum_value IS NULL` disjunct leads deliberately: `field_path` is NOT NULL, so
 * every remaining disjunct evaluates to a real TRUE/FALSE and there is no "NULL is treated as
 * satisfied" hole (the CHECK trap migration 16 documents at length).
 *
 * Both FKs are ON DELETE CASCADE: a note and its feedback are wholly derived from one call and have
 * no meaning without it. This differs from `structured_knowledge` (RESTRICT) on purpose — that row
 * is the durable business asset a delete must not silently take with it, whereas these are
 * regenerable from it.
 *
 * List columns are `jsonb` defaulting to `'[]'`, matching every other list in the schema
 * (`symptoms`, `concerns`, `competitor_mentions`); this codebase has no `text[]` columns.
 *
 * `down` reverses grants, then drops `note_feedback` before `technician_notes`.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

const { retentionColumns } = require('./lib/columns.cjs');

exports.shorthands = undefined;

const now = (pgm) => pgm.func('now()');
const uuid = (pgm) => pgm.func('gen_random_uuid()');

const NOTES = 'technician_notes';
const FEEDBACK = 'note_feedback';

/** Mirrors `NOTE_SCOPE_SIGNALS` in src/db/enums.ts (hand-synced; parity-tested). */
const SCOPE_SIGNALS = ['single_fixture', 'multiple_fixtures', 'whole_property', 'unknown'];
/** Mirrors `NOTE_OCCUPANCIES`. */
const OCCUPANCIES = ['owner', 'tenant', 'property_manager', 'unknown'];
/** Mirrors `NOTE_FEEDBACK_VERDICTS`. */
const VERDICTS = ['correct', 'wrong', 'missing', 'should_not_be_here'];
/** Mirrors `NOTE_BOOLEAN_CORRECTED_VALUES`. */
const BOOLEAN_VALUES = ['true', 'false'];

/** Mirrors `NOTE_BOOLEAN_FIELD_PATHS` — the paths a correction expresses as 'true'/'false'. */
const BOOLEAN_FIELD_PATHS = [
  'water_status.actively_running',
  'water_status.supply_shut_off',
  'water_status.shutoff_location_known',
  'water_status.active_damage',
  'payer_authority.can_approve_work',
  'payer_authority.home_warranty',
  'payer_authority.insurance_claim',
  'payer_authority.third_party_payer',
  'prior_work.is_repeat_visit',
  'prior_work.is_warranty_claim',
  'prior_work.prior_work_by_others',
  'commitments_made.price_quoted',
  'commitments_made.dispatch_fee_mentioned',
  'commitments_made.arrival_window_given',
  'commitments_made.technician_named',
  'commitments_made.scope_described',
];

/** Mirrors `NOTE_FIELD_PATHS` — every addressable field of a note. */
const FIELD_PATHS = [
  'scope_signal',
  'equipment.type',
  'equipment.brand',
  'equipment.model',
  'equipment.capacity',
  'equipment.approximate_age',
  'equipment.fuel_type',
  'system_context.waste_system',
  'system_context.water_source',
  'system_context.foundation_type',
  'system_context.property_age',
  'water_status.actively_running',
  'water_status.supply_shut_off',
  'water_status.shutoff_location_known',
  'water_status.active_damage',
  'payer_authority.can_approve_work',
  'payer_authority.home_warranty',
  'payer_authority.insurance_claim',
  'payer_authority.third_party_payer',
  'prior_work.is_repeat_visit',
  'prior_work.is_warranty_claim',
  'prior_work.prior_work_by_others',
  'commitments_made.price_quoted',
  'commitments_made.dispatch_fee_mentioned',
  'commitments_made.arrival_window_given',
  'commitments_made.technician_named',
  'commitments_made.scope_described',
  'location_on_property',
  'symptom_verbatim',
  'prior_attempts_detail',
  'access_notes',
  'hazards',
  'urgency_context',
  'occupancy',
  'not_established',
  'dispatch_summary',
];

/** `a, b, c` -> `'a', 'b', 'c'` for an IN list. */
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * The jsonb column default for an object field: every key present, every value null.
 *
 * Not `'{}'`. The keys of these objects are a fixed, closed set, so "we never established the
 * brand" and "brand is not a thing we track" must not look alike; a complete key set says the
 * former. It also lets `src/db/schemas/technician-notes.ts` read the column with a `.strict()`
 * schema of plain nullable members — no zod default, so its input and output types stay identical
 * and `parseOrThrow` can type it. The repo writes complete objects for the same reason
 * (`fillNulls`); this default covers a row inserted by raw SQL that omits the column.
 */
const allNull = (keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, null])));

/** Mirrors the note object key tuples in src/db/enums.ts (hand-synced; parity-tested). */
const EQUIPMENT_KEYS = ['type', 'brand', 'model', 'capacity', 'approximate_age', 'fuel_type'];
const SYSTEM_CONTEXT_KEYS = ['waste_system', 'water_source', 'foundation_type', 'property_age'];
const WATER_STATUS_KEYS = [
  'actively_running',
  'supply_shut_off',
  'shutoff_location_known',
  'active_damage',
];
const PAYER_AUTHORITY_KEYS = [
  'can_approve_work',
  'home_warranty',
  'insurance_claim',
  'third_party_payer',
];
const PRIOR_WORK_KEYS = ['is_repeat_visit', 'is_warranty_claim', 'prior_work_by_others'];
const COMMITMENTS_MADE_KEYS = [
  'price_quoted',
  'dispatch_fee_mentioned',
  'arrival_window_given',
  'technician_named',
  'scope_described',
];

/** The columns purge_role may overwrite IF `technician_notes` is ever registered with the
 * retention cron. Granted now so that decision stays a one-line registration; nothing exercises
 * them today (the table is in no purge group). NOT NULL columns scrub to their 'unknown' member,
 * jsonb to its empty default, nullable text to NULL. */
const SCRUBBABLE_COLUMNS = [
  'soft_deleted_at',
  'hard_deleted_at',
  'scope_signal',
  'occupancy',
  'equipment',
  'system_context',
  'water_status',
  'payer_authority',
  'prior_work',
  'commitments_made',
  'location_on_property',
  'symptom_verbatim',
  'prior_attempts_detail',
  'access_notes',
  'hazards',
  'urgency_context',
  'not_established',
  'dispatch_summary',
];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // --- technician_notes: one current, de-identified job-readiness note per call. ---
  pgm.createTable(NOTES, {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'CASCADE' },
    prompt_version: { type: 'text', notNull: true },
    model_id: { type: 'text', notNull: true },
    schema_version: { type: 'integer', notNull: true },
    scope_signal: { type: 'text', notNull: true },
    // Nullable string members: what kind of unit, whose, which model, how big, how old, what fuel.
    equipment: { type: 'jsonb', notNull: true, default: allNull(EQUIPMENT_KEYS) },
    // Nullable string members: septic vs sewer, well vs city, slab vs crawlspace, age of property.
    system_context: { type: 'jsonb', notNull: true, default: allNull(SYSTEM_CONTEXT_KEYS) },
    // Nullable BOOLEAN members — is it still running, is the supply off, do they know where the
    // shutoff is, is there active damage. The emergency triage signal.
    water_status: { type: 'jsonb', notNull: true, default: allNull(WATER_STATUS_KEYS) },
    // Nullable boolean members: can this person authorize the work, and who is paying.
    payer_authority: { type: 'jsonb', notNull: true, default: allNull(PAYER_AUTHORITY_KEYS) },
    // Nullable boolean members: have we been out before, is this under warranty, did someone else
    // work on it. A repeat visit changes how a technician approaches the door.
    prior_work: { type: 'jsonb', notNull: true, default: allNull(PRIOR_WORK_KEYS) },
    location_on_property: { type: 'text' },
    symptom_verbatim: { type: 'text' },
    prior_attempts_detail: { type: 'text' },
    access_notes: { type: 'text' },
    hazards: { type: 'jsonb', notNull: true, default: '[]' },
    urgency_context: { type: 'jsonb', notNull: true, default: '[]' },
    // Nullable boolean members: WHETHER a price/fee/window/technician/scope was communicated —
    // never the amount, the time, or the name. A technician must not contradict what was promised,
    // and knowing a promise exists is enough to make them check before quoting.
    commitments_made: { type: 'jsonb', notNull: true, default: allNull(COMMITMENTS_MADE_KEYS) },
    occupancy: { type: 'text', notNull: true },
    // The honest gaps: which fields the call never answered. Prevents a confident-looking note
    // from reading as complete when it isn't.
    not_established: { type: 'jsonb', notNull: true, default: '[]' },
    dispatch_summary: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    // Present but UNUSED — see the header. Not registered with any retention group.
    ...retentionColumns(),
  });

  pgm.addConstraint(NOTES, `${NOTES}_scope_signal_chk`, {
    check: `scope_signal IN (${quoted(SCOPE_SIGNALS)})`,
  });
  pgm.addConstraint(NOTES, `${NOTES}_occupancy_chk`, {
    check: `occupancy IN (${quoted(OCCUPANCIES)})`,
  });
  // A dispatch summary is meant to be read on a phone in a driveway; 800 characters is the cap
  // that keeps it scannable. Bounded here so the limit survives a raw-SQL writer.
  pgm.addConstraint(NOTES, `${NOTES}_dispatch_summary_len_chk`, {
    check: 'dispatch_summary IS NULL OR char_length(dispatch_summary) <= 800',
  });

  // --- note_feedback: append-only reviewer verdicts on individual note fields. ---
  pgm.createTable(FEEDBACK, {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'CASCADE' },
    // The prompt version of the note the verdict was given AGAINST — a verdict on v1 says nothing
    // about a v2 note, so accuracy is only ever measured within a version.
    note_prompt_version: { type: 'text', notNull: true },
    // The authenticated subject from the session; same shape as operator_actions.actor.
    reviewer_actor: { type: 'text', notNull: true },
    field_path: { type: 'text', notNull: true },
    verdict: { type: 'text', notNull: true },
    corrected_enum_value: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
  });

  pgm.addConstraint(FEEDBACK, `${FEEDBACK}_field_path_chk`, {
    check: `field_path IN (${quoted(FIELD_PATHS)})`,
  });
  pgm.addConstraint(FEEDBACK, `${FEEDBACK}_verdict_chk`, {
    check: `verdict IN (${quoted(VERDICTS)})`,
  });
  // Per-field-path correction vocabulary. Any path not named here is free text and accepts only
  // NULL — the structural reason reviewer prose cannot land in this table.
  pgm.addConstraint(FEEDBACK, `${FEEDBACK}_corrected_value_chk`, {
    check: `
      corrected_enum_value IS NULL
      OR (field_path = 'scope_signal' AND corrected_enum_value IN (${quoted(SCOPE_SIGNALS)}))
      OR (field_path = 'occupancy' AND corrected_enum_value IN (${quoted(OCCUPANCIES)}))
      OR (field_path IN (${quoted(BOOLEAN_FIELD_PATHS)})
          AND corrected_enum_value IN (${quoted(BOOLEAN_VALUES)}))`,
  });

  // Serves the latest-row-wins read (DISTINCT ON over the verdict key, newest first).
  pgm.createIndex(FEEDBACK, ['call_id', 'field_path', 'reviewer_actor', 'note_prompt_version'], {
    name: `${FEEDBACK}_verdict_key_idx`,
  });

  // Grants are explicit per-table (migration 5 pattern). app_role never DELETEs.
  // technician_notes is regenerated in place, so it needs UPDATE; note_feedback is append-only,
  // so SELECT + INSERT only — a stored verdict is history and is never rewritten.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${NOTES} TO app_role;`);
  pgm.sql(`GRANT SELECT, INSERT ON ${FEEDBACK} TO app_role;`);

  // Pre-provisioned purge_role grants (migration 13's column-scoped shape). Dormant: the table is
  // in no purge group. No DELETE — a hypothetical future purge here would be stamp-and-scrub.
  pgm.sql(
    `GRANT SELECT (call_id, retention_eligible_at, soft_deleted_at, hard_deleted_at) ON ${NOTES} TO purge_role;`,
  );
  pgm.sql(`GRANT UPDATE (${SCRUBBABLE_COLUMNS.join(', ')}) ON ${NOTES} TO purge_role;`);
  // note_feedback gets NOTHING: no retention columns, no purge story.
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON ${NOTES} FROM purge_role;`);
  pgm.sql(`REVOKE SELECT, INSERT ON ${FEEDBACK} FROM app_role;`);
  pgm.sql(`REVOKE SELECT, INSERT, UPDATE ON ${NOTES} FROM app_role;`);
  pgm.dropTable(FEEDBACK);
  pgm.dropTable(NOTES);
};
