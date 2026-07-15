'use strict';

/**
 * Migration — structured_knowledge.superseded_by_call_id.
 *
 * A duplicate call-leg row is retired (hidden from the Knowledge base) by pointing it at the
 * canonical call it duplicates. Nullable; NULL means "live". The KB read queries filter on
 * `superseded_by_call_id IS NULL`. Reversible: set back to NULL to restore a row.
 */

exports.shorthands = undefined;

const COLUMN = 'superseded_by_call_id';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('structured_knowledge', {
    [COLUMN]: { type: 'text', references: 'call_state', onDelete: 'RESTRICT' },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('structured_knowledge', COLUMN);
};
