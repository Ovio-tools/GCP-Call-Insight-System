/**
 * Shared column fragments for migrations.
 *
 * This file lives in `migrations/lib/` (a SUBDIRECTORY) on purpose: node-pg-migrate
 * scans `migrations/` non-recursively and only loads directory *files*, so a
 * subdirectory is skipped and never mistaken for a migration. Migration files
 * `require('./lib/columns.cjs')` to share the retention-timestamp definition instead
 * of copy-pasting it onto every purgeable table.
 */

/**
 * The three retention-bookkeeping timestamps every PURGEABLE table carries
 * (CLAUDE.md §2). All nullable — they are stamped over the row's lifetime:
 *   - retention_eligible_at: set by the store stage when the row may be purged.
 *   - soft_deleted_at:       set by the retention cron's soft-delete pass (recoverable).
 *   - hard_deleted_at:       set by the retention cron's hard-delete pass (plaintext gone).
 *
 * Durable tables (e.g. call_state, structured_knowledge) must NOT spread these.
 *
 * @returns {Record<string, import('node-pg-migrate').ColumnDefinition>}
 */
function retentionColumns() {
  return {
    retention_eligible_at: { type: 'timestamptz' },
    soft_deleted_at: { type: 'timestamptz' },
    hard_deleted_at: { type: 'timestamptz' },
  };
}

/** The six purgeable tables that carry {@link retentionColumns}. Single source of
 * truth shared by the migrations and asserted by the retention-columns test. */
const PURGEABLE_TABLES = Object.freeze([
  'raw_webhook_events',
  'raw_transcripts',
  'token_vault',
  'clean_transcripts',
  'redaction_findings',
  'match_keys',
]);

module.exports = { retentionColumns, PURGEABLE_TABLES };
