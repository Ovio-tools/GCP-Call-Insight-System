'use strict';

/**
 * Migration 8 — classify-stage routing vocabularies (Task 5.1).
 *
 * The classify stage adds two new routing outcomes that need controlled vocabulary
 * values:
 *  - spam calls are held for review: `review_queue.held_reason` (native pg enum) gains
 *    `classified_spam`.
 *  - non-customer calls are skipped: `call_state.drop_reason` (text + CHECK, migration
 *    1782864000006) gains `classified_non_customer`.
 *
 * Both additions MUST stay in sync (same values, same order) with `HELD_REASON` and
 * `DROP_REASONS` in src/db/enums.ts — the parity test (test/db/enum-parity.test.ts)
 * compares `held_reason`'s `enum_range(...)` order exactly; `DROP_REASONS` is a
 * hand-kept CHECK mirror (no live-DB order test, but keep it in append order regardless).
 *
 * `ALTER TYPE ... ADD VALUE` runs fine inside a transaction on PG >= 12 as long as the
 * new value isn't used in the same transaction (true here) — this project targets PG 16
 * in CI (.github/workflows/ci.yml) and PG 18 locally, so no `noTransaction` needed.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const VALUE_CHK = 'call_state_drop_reason_value_chk';

/** The drop_reason CHECK list BEFORE this migration (migration 1782864000006). */
const DROP_REASONS_BEFORE = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
];

/** The drop_reason CHECK list AFTER this migration. */
const DROP_REASONS_AFTER = [...DROP_REASONS_BEFORE, 'classified_non_customer'];

/** The held_reason enum's ORIGINAL 9 values, in original order (migration 1782864000001). */
const HELD_REASON_ORIGINAL = [
  'redaction_failed',
  'residual_pii_detected',
  'classifier_uncertain',
  'malformed_model_output',
  'schema_invalid',
  'emergency_review',
  'missing_transcript',
  'cost_cap_held',
  'weak_servicetitan_match',
];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // --- review_queue.held_reason: add 'classified_spam' at the end. ---
  pgm.addTypeValue('held_reason', 'classified_spam');

  // --- call_state.drop_reason: extend the value CHECK to 5 values. Same constraint
  //     name as migration 1782864000006 — drop and re-add under that name. The
  //     biconditional (status='skipped') = (drop_reason IS NOT NULL) constraint from
  //     migration 6 is untouched. ---
  pgm.dropConstraint('call_state', VALUE_CHK);
  const list = DROP_REASONS_AFTER.map((r) => `'${r}'`).join(', ');
  pgm.addConstraint('call_state', VALUE_CHK, {
    check: `drop_reason IS NULL OR drop_reason IN (${list})`,
  });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Fail loud if any row already uses a value this migration is about to remove —
  // mirrors migration 1782864000006's precondition-guard pattern.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM review_queue WHERE held_reason = 'classified_spam') THEN
        RAISE EXCEPTION 'review_queue rows with held_reason=classified_spam must be remediated before rolling back migration 1782864000008';
      END IF;
      IF EXISTS (SELECT 1 FROM call_state WHERE drop_reason = 'classified_non_customer') THEN
        RAISE EXCEPTION 'call_state rows with drop_reason=classified_non_customer must be remediated before rolling back migration 1782864000008';
      END IF;
    END $$;
  `);

  // --- call_state.drop_reason: restore the original 4-value CHECK under the same name. ---
  pgm.dropConstraint('call_state', VALUE_CHK);
  const originalList = DROP_REASONS_BEFORE.map((r) => `'${r}'`).join(', ');
  pgm.addConstraint('call_state', VALUE_CHK, {
    check: `drop_reason IS NULL OR drop_reason IN (${originalList})`,
  });

  // --- review_queue.held_reason: Postgres has no DROP VALUE, so rebuild the type.
  //     review_queue.held_reason has no default, so no default to drop/restore first. ---
  pgm.renameType('held_reason', 'held_reason_old');
  pgm.createType('held_reason', HELD_REASON_ORIGINAL);
  pgm.sql(
    'ALTER TABLE review_queue ' +
      'ALTER COLUMN held_reason TYPE held_reason USING held_reason::text::held_reason;',
  );
  pgm.dropType('held_reason_old');
};
