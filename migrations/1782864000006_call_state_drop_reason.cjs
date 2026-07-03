'use strict';

/**
 * Migration 6 — call_state.drop_reason (Task 3.1, metadata pre-filter).
 *
 * Adds a nullable drop_reason recording WHY a call was skipped by the metadata
 * pre-filter, plus two CHECK constraints:
 *  - value: drop_reason must be NULL or one of the controlled DROP_REASONS. This list
 *    MUST stay in sync with DROP_REASONS in src/db/enums.ts (hand-kept, like the ENUMS
 *    mirror).
 *  - relationship: (status='skipped') = (drop_reason IS NOT NULL) — a skipped row must
 *    carry a reason and only a skipped row may carry one.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
];

const VALUE_CHK = 'call_state_drop_reason_value_chk';
const REL_CHK = 'call_state_status_drop_reason_chk';

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('call_state', { drop_reason: { type: 'text' } });
  const list = DROP_REASONS.map((r) => `'${r}'`).join(', ');
  pgm.addConstraint('call_state', VALUE_CHK, {
    check: `drop_reason IS NULL OR drop_reason IN (${list})`,
  });

  // Precondition: fail loud if any pre-existing 'skipped' rows exist. Before Task 3.1 the
  // status vocabulary was only 'processing'/'completed', so a 'skipped' row here would
  // carry a NULL drop_reason (the column is brand new) and would make the biconditional
  // constraint below fail to validate. Remediate such rows before migrating.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM call_state WHERE status = 'skipped') THEN
        RAISE EXCEPTION 'pre-existing skipped call_state rows must be remediated before migration 1782864000006';
      END IF;
    END $$;
  `);

  pgm.addConstraint('call_state', REL_CHK, {
    check: `(status = 'skipped') = (drop_reason IS NOT NULL)`,
  });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint('call_state', REL_CHK);
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.dropColumn('call_state', 'drop_reason');
};
