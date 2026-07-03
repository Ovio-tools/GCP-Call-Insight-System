'use strict';

/**
 * Migration 7 — call_state.transcript_wait_started_at (Task 3.3, fetch-transcript).
 *
 * Records WHEN the fetch-transcript stage first observed a not-yet-ready transcript for
 * a call. The stage bounds its non-blocking retry window against this timestamp: while
 * `now() - transcript_wait_started_at < DIALPAD_TRANSCRIPT_WAIT_MAX_MS` it defers (a
 * delayed re-run); once the window passes it holds the call with `missing_transcript`.
 *
 * Nullable and additive — null until the first not-ready observation. Fully reversible
 * (down drops the column); no data is destroyed.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('call_state', { transcript_wait_started_at: { type: 'timestamptz' } });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('call_state', 'transcript_wait_started_at');
};
