'use strict';

/**
 * Migration 11 — alert_events delivery columns (Task 7.3, alert delivery).
 *
 * `recordAlert` dedups a repeated incident onto ONE row (partial unique index on
 * `dedup_key` while unacknowledged), so a failed FIRST delivery would otherwise never be
 * retried — later duplicates just return the existing row. These columns make delivery a
 * DURABLE, retryable obligation carried by the row itself, so any newly inserted alert —
 * including one from a direct low-level `recordAlert` caller — is picked up by the retry
 * sweep exactly once.
 *
 * The defaults are the crux: a row created but never delivered (crash after insert, or
 * inserted while `ALERT_WEBHOOK_URL` is unset) is still `pending` with a non-null
 * `next_attempt_at`, so the sweep finds it.
 *
 *  - delivery_state     text NOT NULL DEFAULT 'pending'  (pending|delivered|failed), guarded
 *                       by a CHECK so no path can strand a row in an invalid state.
 *  - delivery_attempts  integer NOT NULL DEFAULT 0
 *  - next_attempt_at    timestamptz NOT NULL DEFAULT now()  — never null.
 *  - delivered_at       timestamptz NULL
 *  - last_delivery_error text NULL  (sanitized — never the webhook URL, a secret, or PII)
 *
 * Backfill of pre-existing rows: acknowledged incidents are treated as already handled
 * (`delivered`, excluded from retry); unacknowledged incidents become `pending` with
 * `next_attempt_at = created_at` so the sweep delivers them once. A `(delivery_state,
 * next_attempt_at)` index supports the sweep's selection. Fully reversible.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const STATE_CHK = 'alert_events_delivery_state_chk';
const SWEEP_IDX = 'alert_events_delivery_sweep_idx';

/** DEFAULT now() for a timestamptz column. */
const now = (pgm) => pgm.func('now()');

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns('alert_events', {
    delivery_state: { type: 'text', notNull: true, default: 'pending' },
    delivery_attempts: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    delivered_at: { type: 'timestamptz' },
    last_delivery_error: { type: 'text' },
  });

  // A bad manual/future SQL write can't strand a row in an invalid state.
  pgm.addConstraint('alert_events', STATE_CHK, {
    check: "delivery_state IN ('pending', 'delivered', 'failed')",
  });

  // Backfill: already-acknowledged incidents are treated as handled (no retry); their
  // delivered_at is best-effort stamped from acknowledged_at. Unacknowledged incidents stay
  // pending and are given next_attempt_at = created_at so the sweep delivers them once.
  pgm.sql(`
    UPDATE alert_events
       SET delivery_state = 'delivered',
           delivered_at = acknowledged_at
     WHERE acknowledged_at IS NOT NULL;
  `);
  pgm.sql(`
    UPDATE alert_events
       SET next_attempt_at = created_at
     WHERE acknowledged_at IS NULL;
  `);

  pgm.createIndex('alert_events', ['delivery_state', 'next_attempt_at'], { name: SWEEP_IDX });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('alert_events', ['delivery_state', 'next_attempt_at'], { name: SWEEP_IDX });
  pgm.dropConstraint('alert_events', STATE_CHK);
  pgm.dropColumns('alert_events', [
    'delivery_state',
    'delivery_attempts',
    'next_attempt_at',
    'delivered_at',
    'last_delivery_error',
  ]);
};
