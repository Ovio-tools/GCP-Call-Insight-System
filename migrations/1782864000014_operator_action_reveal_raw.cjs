'use strict';

/**
 * Migration 14 — operator_action += reveal_raw (Task 6.2).
 *
 * The review surface's elevated raw/vault reveal writes an audit row whose `action` needs a
 * controlled `operator_action` value. `reveal_raw` is APPENDED at the end so its ordinal
 * matches `OPERATOR_ACTION` in src/db/enums.ts — the parity test (test/db/enum-parity.test.ts)
 * compares `enum_range('operator_action')` order exactly.
 *
 * `ALTER TYPE ... ADD VALUE` runs inside a transaction on PG >= 12 as long as the new value
 * isn't used in the same transaction (true here) — same rationale as migration 8.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

/** The operator_action enum's values BEFORE this migration (migration 1782864000001). */
const OPERATOR_ACTION_BEFORE = [
  'approve',
  'reject',
  'reprocess',
  'mark_non_customer',
  'mark_spam',
  'correct_extraction',
  'mark_unresolvable',
];

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addTypeValue('operator_action', 'reveal_raw');
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Fail loud if any row already uses the value this migration is about to remove — mirrors
  // migration 8's precondition-guard pattern.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM operator_actions WHERE action = 'reveal_raw') THEN
        RAISE EXCEPTION 'operator_actions rows with action=reveal_raw must be remediated before rolling back migration 1782864000014';
      END IF;
    END $$;
  `);

  // Postgres has no DROP VALUE, so rebuild the type. operator_actions.action has no default,
  // so there is no default to drop/restore first.
  pgm.renameType('operator_action', 'operator_action_old');
  pgm.createType('operator_action', OPERATOR_ACTION_BEFORE);
  pgm.sql(
    'ALTER TABLE operator_actions ' +
      'ALTER COLUMN action TYPE operator_action USING action::text::operator_action;',
  );
  pgm.dropType('operator_action_old');
};
