'use strict';

/**
 * Migration 18 — backfill run status + tracking (Task 11.2).
 *
 * The historical backfill runner (`src/backfill/`) needs three things the scaffolding
 * `backfill_runs` table (migration 2) did not provide:
 *
 *  1. A `status` CHECK pinning the lifecycle vocabulary `running` → (`completed` | `interrupted`
 *     | `failed`). `running`/`interrupted`/`failed` are all RESUMABLE; only `completed` is final.
 *  2. A UNIQUE partial index on `(window_start, window_end)` restricted to the resumable statuses,
 *     so at most ONE resumable run can exist per exact window — `completed` runs are excluded, so
 *     re-running a finished window is fine, but a second concurrent/duplicate run for a window
 *     that already has a resumable row is refused (the runner then requires `--resume`/`--restart`).
 *  3. `backfill_run_calls (backfill_run_id, call_id)` — the terminal-completion tracking table.
 *     Completion is "every seeded/rescued call reached a terminal state", NOT "every call was
 *     enqueued", so a rescued pre-existing seed (which already has a `call_state` row and would
 *     never receive a run-id stamp) is tracked here and awaited by the drain phase.
 *
 * Grants: app_role gets SELECT/INSERT/DELETE on `backfill_run_calls`. DELETE is a deliberate,
 * documented exception to the "app_role never deletes" convention — the `--restart-from-scratch`
 * contract (`resetRun`) clears a run's tracking rows via the app pool. This is operational
 * bookkeeping (a derived, non-PII tracking table), NOT the retention purge_role deletion path.
 *
 * `down` reverses grants, drops the tracking table, the partial index, and the status CHECK.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const RUNS = 'backfill_runs';
const RUN_CALLS = 'backfill_run_calls';
const STATUS_CHK = 'backfill_runs_status_chk';
const RESUMABLE_IDX = 'backfill_runs_resumable_window_uniq';

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  // (1) Pin the run-status vocabulary.
  pgm.addConstraint(RUNS, STATUS_CHK, {
    check: "status IN ('running', 'completed', 'interrupted', 'failed')",
  });

  // (2) At most one RESUMABLE run per exact window. `completed` is excluded, so a finished window
  //     may be re-run; a resumable row blocks a second concurrent/duplicate run for that window.
  pgm.createIndex(RUNS, ['window_start', 'window_end'], {
    name: RESUMABLE_IDX,
    unique: true,
    where: "status IN ('running', 'interrupted', 'failed')",
  });

  // (3) Terminal-completion tracking: every call a run enqueues OR rescues. Composite PK makes
  //     insert-if-absent idempotent. ON DELETE CASCADE on the run (tracking is meaningless without
  //     its run); ON DELETE NO ACTION on call_state (the durable per-call spine is never deleted).
  pgm.createTable(RUN_CALLS, {
    backfill_run_id: {
      type: 'uuid',
      notNull: true,
      references: RUNS,
      onDelete: 'CASCADE',
    },
    call_id: {
      type: 'text',
      notNull: true,
      references: 'call_state',
      onDelete: 'NO ACTION',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(RUN_CALLS, `${RUN_CALLS}_pkey`, {
    primaryKey: ['backfill_run_id', 'call_id'],
  });

  // Grants: SELECT/INSERT/DELETE (restart clears tracking via the app pool — see header).
  pgm.sql(`GRANT SELECT, INSERT, DELETE ON ${RUN_CALLS} TO app_role;`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`REVOKE SELECT, INSERT, DELETE ON ${RUN_CALLS} FROM app_role;`);
  pgm.dropTable(RUN_CALLS);
  pgm.dropIndex(RUNS, ['window_start', 'window_end'], { name: RESUMABLE_IDX });
  pgm.dropConstraint(RUNS, STATUS_CHK);
};
