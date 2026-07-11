'use strict';

/**
 * Migration 9 — extract stage (Task 5.2).
 *
 * 1. `extraction_candidates`: the PURGEABLE staging table between the extract stage and
 *    the Task 5.3 store stage. The extract stage validates a model-extracted record
 *    entirely in memory and persists only a clean candidate here; the verbatim-pii-scan
 *    stage then re-verifies the persisted row via the crash-safe `pii_scan_status`
 *    marker. Task 5.3 copies passed candidates into `structured_knowledge`.
 *
 * 2. `structured_knowledge` gains the deferred `service_category` / `sentiment` CHECKs
 *    that migration 1782864000002 announced as "lands in Task 5.2" — the table is empty
 *    until Task 5.3 writes it, so adding them now is additive and safe. Migration 2
 *    itself is untouched; this fulfills its comment.
 *
 * The controlled vocabularies below are hand-kept mirrors of `SERVICE_CATEGORIES`,
 * `SENTIMENTS`, `PII_SCAN_STATUSES`, and `PII_SCAN_FAILURE_KINDS` in `src/db/enums.ts`
 * (same duplication convention as DROP_REASONS / migration 6 and 8): text + CHECK, NOT
 * native pg enums, so the enum-parity test is untouched. Keep both files in sync.
 *
 * Retention columns are spread directly instead of appending to
 * `migrations/lib/columns.cjs` PURGEABLE_TABLES — migration 5's purge grants consume
 * that list at migration time, so appending would change what a FRESH run of migration
 * 5 grants and diverge from an already-migrated database. Grants for this table are
 * explicit below instead.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');

exports.shorthands = undefined;

/** Mirror of SERVICE_CATEGORIES in src/db/enums.ts — keep in sync, same order. */
const SERVICE_CATEGORIES = [
  'water_heater',
  'drain_blockage',
  'leak_detection_or_repair',
  'sewer_or_septic',
  'toilet',
  'faucet_sink_or_fixture',
  'shower_or_tub',
  'gas_line',
  'sump_pump_or_drainage',
  'water_quality_or_treatment',
  'repipe_or_pipe_repair',
  'appliance_install_or_hookup',
  'inspection_or_maintenance',
  'grinder_pump',
  'other',
];

/** Mirror of SENTIMENTS in src/db/enums.ts — keep in sync, same order. */
const SENTIMENTS = ['positive', 'neutral', 'negative', 'frustrated'];

/** Mirror of PII_SCAN_STATUSES in src/db/enums.ts — keep in sync, same order. */
const PII_SCAN_STATUSES = ['pending', 'passed', 'failed'];

/** Mirror of PII_SCAN_FAILURE_KINDS in src/db/enums.ts — keep in sync, same order. */
const PII_SCAN_FAILURE_KINDS = ['residual_pii', 'tokened_phrase', 'verbatim_mismatch'];

/** Values as a quoted SQL IN-list. */
const sqlList = (values) => values.map((v) => `'${v}'`).join(', ');

const TABLE = 'extraction_candidates';

const CHECKS = {
  serviceCategory: 'extraction_candidates_service_category_chk',
  sentiment: 'extraction_candidates_sentiment_chk',
  scanStatus: 'extraction_candidates_pii_scan_status_chk',
  failureKind: 'extraction_candidates_pii_scan_failure_kind_chk',
  failedKind: 'extraction_candidates_failed_kind_chk',
};

const SK_CHECKS = {
  serviceCategory: 'structured_knowledge_service_category_chk',
  sentiment: 'structured_knowledge_sentiment_chk',
};

/** @param {MB} pgm */
exports.up = (pgm) => {
  // --- extraction_candidates: purgeable staging between extract and the 5.3 store.
  //     PK-only on purpose: rows are only ever addressed by call_id, and a staging
  //     table must not grow into a queried second knowledge store. ---
  pgm.createTable(TABLE, {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    call_intent: { type: 'call_intent', notNull: true },
    service_category: { type: 'text', notNull: true },
    problem_statement: { type: 'text' },
    symptoms: { type: 'jsonb', notNull: true, default: '[]' },
    customer_language: { type: 'jsonb', notNull: true, default: '[]' },
    location_in_home: { type: 'text' },
    access_or_scheduling_notes: { type: 'text' },
    prior_attempts: { type: 'text' },
    urgency: { type: 'urgency', notNull: true },
    concerns: { type: 'jsonb', notNull: true, default: '[]' },
    sentiment: { type: 'text', notNull: true },
    acquisition_source: { type: 'text' },
    competitor_mentions: { type: 'jsonb', notNull: true, default: '[]' },
    // Crash-safe verbatim-scan marker: pending on every (re-)insert; the scan stage
    // moves it to passed/failed. failed is a one-way privacy latch at the DAL layer.
    pii_scan_status: { type: 'text', notNull: true, default: 'pending' },
    pii_scan_failure_kind: { type: 'text' },
    pii_scan_failed_at: { type: 'timestamptz' },
    // Numeric-only failure metadata (counts keyed by residual-scan category, or
    // dropped/mismatch counts) — never phrase text.
    pii_scan_counts: { type: 'jsonb' },
    schema_version: { type: 'integer', notNull: true },
    prompt_version: { type: 'text', notNull: true },
    model_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ...retentionColumns(),
  });

  pgm.addConstraint(TABLE, CHECKS.serviceCategory, {
    check: `service_category IN (${sqlList(SERVICE_CATEGORIES)})`,
  });
  pgm.addConstraint(TABLE, CHECKS.sentiment, {
    check: `sentiment IN (${sqlList(SENTIMENTS)})`,
  });
  pgm.addConstraint(TABLE, CHECKS.scanStatus, {
    check: `pii_scan_status IN (${sqlList(PII_SCAN_STATUSES)})`,
  });
  pgm.addConstraint(TABLE, CHECKS.failureKind, {
    check: `pii_scan_failure_kind IS NULL OR pii_scan_failure_kind IN (${sqlList(PII_SCAN_FAILURE_KINDS)})`,
  });
  // failed and only failed carries a kind.
  pgm.addConstraint(TABLE, CHECKS.failedKind, {
    check: `(pii_scan_status = 'failed') = (pii_scan_failure_kind IS NOT NULL)`,
  });

  pgm.sql(
    `COMMENT ON TABLE ${TABLE} IS ` +
      "'Purgeable STAGING only, between the extract stage and the Task 5.3 store — " +
      "never a second durable knowledge store. structured_knowledge is the durable asset.';",
  );

  // --- structured_knowledge: the CHECKs migration 2 deferred to Task 5.2. Empty until
  //     Task 5.3 stores rows, so purely additive. Same value lists as above. ---
  pgm.addConstraint('structured_knowledge', SK_CHECKS.serviceCategory, {
    check: `service_category IN (${sqlList(SERVICE_CATEGORIES)})`,
  });
  pgm.addConstraint('structured_knowledge', SK_CHECKS.sentiment, {
    check: `sentiment IN (${sqlList(SENTIMENTS)})`,
  });

  // --- Grants: explicit, mirroring migration 5's style (app_role writes, purge_role
  //     deletes, restricted_role gets nothing). ---
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${TABLE} TO app_role;`);
  pgm.sql(`GRANT DELETE ON ${TABLE} TO purge_role;`);
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  // Fail loud if any staging rows exist (even soft-deleted ones): dropping the table
  // would silently destroy in-flight extraction candidates. Remediate first — let the
  // 5.3 store / retention purge drain the table, or clear it deliberately. Mirrors the
  // migration 6/8 precondition-guard pattern.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM extraction_candidates) THEN
        RAISE EXCEPTION 'extraction_candidates rows must be remediated (drained or deliberately cleared) before rolling back migration 1782864000009';
      END IF;
    END $$;
  `);

  pgm.sql(`REVOKE DELETE ON ${TABLE} FROM purge_role;`);
  pgm.sql(`REVOKE SELECT, INSERT, UPDATE ON ${TABLE} FROM app_role;`);

  pgm.dropConstraint('structured_knowledge', SK_CHECKS.sentiment);
  pgm.dropConstraint('structured_knowledge', SK_CHECKS.serviceCategory);

  pgm.dropTable(TABLE);
};
