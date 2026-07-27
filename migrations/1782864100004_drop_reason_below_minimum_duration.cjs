'use strict';

/**
 * Migration — add 'below_minimum_duration' to the call_state.drop_reason value CHECK.
 *
 * The metadata pre-filter drops a call whose duration is at or below
 * PREFILTER_MIN_DURATION_MS: too short to hold a conversation, so it can never produce a
 * transcript and holding it only manufactures unactionable review work. Distinct from
 * 'zero_duration' (which means the call never connected at all).
 *
 * The list MUST stay in sync with DROP_REASONS in src/db/enums.ts (hand-kept, like
 * migration 1782864000006).
 */

exports.shorthands = undefined;

const VALUE_CHK = 'call_state_drop_reason_value_chk';

const OLD_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
  'classified_non_customer',
  'duplicate_call_leg',
];
const NEW_REASONS = [...OLD_REASONS, 'below_minimum_duration'];

const chk = (reasons) =>
  `drop_reason IS NULL OR drop_reason IN (${reasons.map((r) => `'${r}'`).join(', ')})`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.addConstraint('call_state', VALUE_CHK, { check: chk(NEW_REASONS) });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Fail loud if any row already uses the new value — dropping it would orphan those rows.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM call_state WHERE drop_reason = 'below_minimum_duration') THEN
        RAISE EXCEPTION 'cannot revert: call_state rows use drop_reason=below_minimum_duration';
      END IF;
    END $$;
  `);
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.addConstraint('call_state', VALUE_CHK, { check: chk(OLD_REASONS) });
};
