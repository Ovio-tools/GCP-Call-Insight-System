/**
 * Shared column fragments for DB-B (raw store) migrations.
 *
 * This file lives in `migrations-raw/lib/` (a SUBDIRECTORY) on purpose: node-pg-migrate
 * scans `migrations-raw/` non-recursively and only loads directory *files*, so a
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
 * Durable tables must NOT spread these.
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

/** The purgeable tables on DB-B (raw store) that carry {@link retentionColumns}. Scoped to
 * DB-B's tables only — nothing on DB-B consumes the DB-A purgeable list, and a stale copy of
 * it would mislead. */
const PURGEABLE_TABLES = Object.freeze(['raw_transcripts', 'token_vault']);

module.exports = { retentionColumns, PURGEABLE_TABLES };
