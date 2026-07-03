'use strict';

/**
 * Migration 12 — review_queue active-row invariants (Task 6.1).
 *
 * Turns "exactly one ACTIVE (open/in_review) review row per call" and "every active review
 * row carries an SLA" from procedural guarantees into DB guarantees:
 *
 *  - partial UNIQUE index `review_queue_one_active_per_call (call_id) WHERE status IN
 *    ('open','in_review')` — the `holdCall` / `enqueueReview` writers target it by index
 *    inference (`ON CONFLICT (call_id) WHERE status IN (...)`).
 *  - CHECK `review_queue_active_has_sla` — an active row must have a non-null `sla_due_at`,
 *    so the stalled-review scan (`sla_due_at < now`) can never silently miss a NULL-SLA row.
 *
 * Both invariants were only procedural until now, so a live DB could already violate them.
 * Two loud `up` preflights (the codebase's `DO $$ ... RAISE EXCEPTION` convention, cf.
 * migration 6) refuse to migrate — WITHOUT auto-deleting/merging — if pre-existing data
 * violates either, naming the invariant so a human resolves it first.
 *
 * No new columns: `sla_due_at`, `escalated_at`, `raw_purged_at`, `status`, `created_at` all
 * exist from migration 2.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const ACTIVE_UNIQUE_IDX = 'review_queue_one_active_per_call';
const ACTIVE_SLA_CHK = 'review_queue_active_has_sla';
const ACTIVE = "status IN ('open', 'in_review')";

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // Preflight 1: no pre-existing duplicate active rows. A CREATE UNIQUE INDEX over them would
  // otherwise fail with an opaque error. Do NOT auto-delete — a human resolves them first.
  pgm.sql(`
    DO $$
    DECLARE dup_calls int; sample text;
    BEGIN
      SELECT count(*), min(call_id) INTO dup_calls, sample
      FROM (
        SELECT call_id FROM review_queue
        WHERE ${ACTIVE}
        GROUP BY call_id
        HAVING count(*) > 1
      ) d;
      IF dup_calls > 0 THEN
        RAISE EXCEPTION 'migration 1782864000012: % call_id(s) have multiple active review rows (e.g. %) — the "exactly one active review row per call" invariant is violated. Resolve the duplicates by hand before migrating (this migration does NOT auto-delete).', dup_calls, sample;
      END IF;
    END $$;
  `);

  // Preflight 2: every active row already carries an SLA. A NULL-sla active row would slip
  // past the CHECK's validation AND is invisible to the stalled scan (sla_due_at < now is
  // false for NULL), so refuse rather than let one linger.
  pgm.sql(`
    DO $$
    DECLARE null_sla int;
    BEGIN
      SELECT count(*) INTO null_sla FROM review_queue
      WHERE ${ACTIVE} AND sla_due_at IS NULL;
      IF null_sla > 0 THEN
        RAISE EXCEPTION 'migration 1782864000012: % active review row(s) have a NULL sla_due_at — every active review row must carry an SLA. Backfill sla_due_at before migrating.', null_sla;
      END IF;
    END $$;
  `);

  pgm.createIndex('review_queue', 'call_id', {
    name: ACTIVE_UNIQUE_IDX,
    unique: true,
    where: ACTIVE,
  });

  pgm.addConstraint('review_queue', ACTIVE_SLA_CHK, {
    check: `status NOT IN ('open', 'in_review') OR sla_due_at IS NOT NULL`,
  });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint('review_queue', ACTIVE_SLA_CHK);
  pgm.dropIndex('review_queue', 'call_id', { name: ACTIVE_UNIQUE_IDX });
};
