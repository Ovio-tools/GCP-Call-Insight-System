'use strict';

/**
 * Migration 13 — Task 8.1 retention/purge least-privilege grants + one-time eligibility backfill.
 *
 * The retention cron runs its purge as `purge_role`. Migrations 5/9 gave `purge_role` only
 * DELETE on the seven purgeable tables (no SELECT/UPDATE). Task 8.1's normal hard delete is
 * stamp-and-scrub (an UPDATE that sets `hard_deleted_at` and overwrites the content columns),
 * and only the held-cap purge is a physical DELETE (of `raw_transcripts` + `token_vault`). So
 * this migration:
 *
 *   1. GRANTs `purge_role` COLUMN-SCOPED SELECT (identifier + retention triplet only — never
 *      content/ciphertext) and COLUMN-SCOPED UPDATE (soft/hard timestamps + the exact scrub
 *      columns) on every purgeable table + `extraction_candidates`.
 *   2. REVOKEs DELETE from the five stamp-and-scrub tables, leaving DELETE on ONLY
 *      `raw_transcripts` + `token_vault` (the held-cap physical delete).
 *   3. GRANTs narrow `review_queue` access: `purge_role` SELECT (id, call_id, status,
 *      created_at, raw_purged_at) + UPDATE (raw_purged_at); `restricted_role` SELECT (call_id,
 *      raw_purged_at) for the `putToken` held-cap finality guard.
 *   4. BACKFILLS `retention_eligible_at` for rows created before Task 8.1's creation-time
 *      stamping (webhook/clean/findings), so pre-existing rows are not immortal.
 *
 * Reversibility: the GRANT/REVOKE portion is fully reversible — `down()` restores the exact
 * pre-013 privilege state (DELETE re-granted on the five tables, all new grants revoked). The
 * data-repair BACKFILL is FORWARD-ONLY: its inverse (nulling `retention_eligible_at`) could
 * unset a legitimately-stamped value that merely happens to equal `created_at`/`received_at`,
 * so `down()` deliberately does NOT reverse it. Do not write tests that depend on backfill
 * rollback. Style follows `1782864000005_grants.cjs`.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

/**
 * Per-table purge metadata (review P2): identifiers differ per table, so grants are explicit,
 * never a blanket table grant.
 *   - idCols: the SELECT identifier column(s) + the primary batch selector.
 *   - scrubCols: the content columns the hard-delete stamp-and-scrub overwrites (UPDATE grant).
 */
const TRIPLET = ['retention_eligible_at', 'soft_deleted_at', 'hard_deleted_at'];

const PURGE_TABLES = [
  { table: 'raw_transcripts', idCols: ['call_id'], scrubCols: ['ciphertext'] },
  { table: 'token_vault', idCols: ['call_id', 'token'], scrubCols: ['ciphertext'] },
  {
    table: 'clean_transcripts',
    idCols: ['call_id'],
    scrubCols: ['redacted_text', 'redaction_reasons'],
  },
  {
    table: 'redaction_findings',
    idCols: ['id', 'call_id'],
    scrubCols: ['value_hash', 'residual_scan_result'],
  },
  { table: 'raw_webhook_events', idCols: ['id', 'received_at'], scrubCols: ['payload'] },
  { table: 'match_keys', idCols: ['id', 'call_id'], scrubCols: ['phone_hmac', 'name_hmac'] },
  {
    table: 'extraction_candidates',
    idCols: ['call_id'],
    // Every content-bearing field; the NOT-NULL enum/metadata columns are deliberately kept
    // (tombstone validity) so are NOT in the UPDATE grant.
    scrubCols: [
      'problem_statement',
      'location_in_home',
      'access_or_scheduling_notes',
      'prior_attempts',
      'acquisition_source',
      'symptoms',
      'customer_language',
      'concerns',
      'competitor_mentions',
      'pii_scan_counts',
    ],
  },
];

/** Tables whose hard delete is stamp-and-scrub (UPDATE) — DELETE is revoked from purge_role. */
const DELETE_REVOKED = [
  'clean_transcripts',
  'redaction_findings',
  'raw_webhook_events',
  'match_keys',
  'extraction_candidates',
];

/** @param {MB} pgm */
exports.up = (pgm) => {
  for (const { table, idCols, scrubCols } of PURGE_TABLES) {
    const selectCols = [...idCols, ...TRIPLET].join(', ');
    const updateCols = ['soft_deleted_at', 'hard_deleted_at', ...scrubCols].join(', ');
    pgm.sql(`GRANT SELECT (${selectCols}) ON ${table} TO purge_role;`);
    pgm.sql(`GRANT UPDATE (${updateCols}) ON ${table} TO purge_role;`);
  }

  // Normal hard delete is stamp-and-scrub (UPDATE); only the held-cap purge physically DELETEs
  // raw_transcripts + token_vault. Revoke DELETE everywhere else purge_role held it (migs 5/9).
  for (const table of DELETE_REVOKED) {
    pgm.sql(`REVOKE DELETE ON ${table} FROM purge_role;`);
  }

  // review_queue: purge_role reads the held-cap seam columns + stamps raw_purged_at; it may
  // NOT see the sensitive review columns (assignee/held_reason/sla_due_at) or change status.
  pgm.sql(
    `GRANT SELECT (id, call_id, status, created_at, raw_purged_at) ON review_queue TO purge_role;`,
  );
  pgm.sql(`GRANT UPDATE (raw_purged_at) ON review_queue TO purge_role;`);
  // restricted_role needs the two non-sensitive columns for the putToken held-cap finality
  // guard (a minor, defensible boundary extension: review_queue holds no raw PII, and
  // restricted_role still cannot decrypt).
  pgm.sql(`GRANT SELECT (call_id, raw_purged_at) ON review_queue TO restricted_role;`);

  // One-time eligibility backfill (FORWARD-ONLY — see header). Rows created before the
  // creation-time stamping change have retention_eligible_at IS NULL and would never purge.
  // Raw/vault are intentionally NOT backfilled (their eligibility is post-store, via the
  // mark-retention-eligible stage + the held-cap/blocking predicate). `match_keys` IS backfilled:
  // it already had a live writer (`putMatchKeys`) that did not stamp eligibility, so any deployed
  // rows would be immortal to the purge predicate; a hard-deleted (crypto-shredded) row is skipped.
  pgm.sql(
    `UPDATE raw_webhook_events SET retention_eligible_at = received_at WHERE retention_eligible_at IS NULL;`,
  );
  pgm.sql(
    `UPDATE clean_transcripts SET retention_eligible_at = created_at WHERE retention_eligible_at IS NULL;`,
  );
  pgm.sql(
    `UPDATE redaction_findings SET retention_eligible_at = created_at WHERE retention_eligible_at IS NULL;`,
  );
  pgm.sql(
    `UPDATE match_keys SET retention_eligible_at = created_at WHERE retention_eligible_at IS NULL AND hard_deleted_at IS NULL;`,
  );
};

/** @param {MB} pgm — restores the exact pre-013 privilege state; the backfill is NOT reversed. */
exports.down = (pgm) => {
  pgm.sql(`REVOKE SELECT (call_id, raw_purged_at) ON review_queue FROM restricted_role;`);
  pgm.sql(`REVOKE UPDATE (raw_purged_at) ON review_queue FROM purge_role;`);
  pgm.sql(
    `REVOKE SELECT (id, call_id, status, created_at, raw_purged_at) ON review_queue FROM purge_role;`,
  );

  // Restore DELETE on the five stamp-and-scrub tables (migrations 5/9 granted it).
  for (const table of DELETE_REVOKED) {
    pgm.sql(`GRANT DELETE ON ${table} TO purge_role;`);
  }

  for (const { table, idCols, scrubCols } of PURGE_TABLES) {
    const selectCols = [...idCols, ...TRIPLET].join(', ');
    const updateCols = ['soft_deleted_at', 'hard_deleted_at', ...scrubCols].join(', ');
    pgm.sql(`REVOKE UPDATE (${updateCols}) ON ${table} FROM purge_role;`);
    pgm.sql(`REVOKE SELECT (${selectCols}) ON ${table} FROM purge_role;`);
  }
};
