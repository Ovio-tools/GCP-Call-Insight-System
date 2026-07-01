'use strict';

/**
 * Migration 3/5 — restricted / envelope-encrypted tables.
 *
 * Kept separate from the core tables so the grants migration has a clean target and a
 * reviewer sees every sensitive store in one place:
 *   - raw_transcripts: original transcript, envelope-encrypted (ciphertext + key_version).
 *   - token_vault:     token -> original-value map, envelope-encrypted. RESTRICTED role only.
 *   - match_keys:      salted HMACs for ServiceTitan matching.   RESTRICTED role only.
 *
 * All three are purgeable (retention columns) and reference call_state + key_versions,
 * both created in migration 2.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

const { retentionColumns } = require('./lib/columns.cjs');

exports.shorthands = undefined;

const now = (pgm) => pgm.func('now()');
const uuid = (pgm) => pgm.func('gen_random_uuid()');

/** @param {MB} pgm */
exports.up = (pgm) => {
  // --- raw_transcripts: one encrypted transcript per call. ---
  pgm.createTable('raw_transcripts', {
    call_id: { type: 'text', primaryKey: true, references: 'call_state', onDelete: 'RESTRICT' },
    ciphertext: { type: 'bytea', notNull: true },
    key_version: {
      type: 'integer',
      notNull: true,
      references: 'key_versions',
      onDelete: 'RESTRICT',
    },
    fetched_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });

  // --- token_vault: per-call token -> encrypted original value. Tokens ([NAME_1],
  //     [PHONE_1], ...) recur across calls, so the key is composite (call_id, token). ---
  pgm.createTable(
    'token_vault',
    {
      call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
      token: { type: 'text', notNull: true },
      ciphertext: { type: 'bytea', notNull: true },
      key_version: {
        type: 'integer',
        notNull: true,
        references: 'key_versions',
        onDelete: 'RESTRICT',
      },
      created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
      ...retentionColumns(),
    },
    { constraints: { primaryKey: ['call_id', 'token'] } },
  );
  // No separate call_id index: the composite PK's leading column covers call_id lookups.

  // --- match_keys: salted HMAC hashes of phone/name for ServiceTitan matching. ---
  pgm.createTable('match_keys', {
    id: { type: 'uuid', primaryKey: true, default: uuid(pgm) },
    call_id: { type: 'text', notNull: true, references: 'call_state', onDelete: 'RESTRICT' },
    phone_hmac: { type: 'bytea' },
    name_hmac: { type: 'bytea' },
    key_version: {
      type: 'integer',
      notNull: true,
      references: 'key_versions',
      onDelete: 'RESTRICT',
    },
    created_at: { type: 'timestamptz', notNull: true, default: now(pgm) },
    ...retentionColumns(),
  });
  pgm.createIndex('match_keys', 'phone_hmac', { name: 'match_keys_phone_hmac_idx' });
  pgm.createIndex('match_keys', 'name_hmac', { name: 'match_keys_name_hmac_idx' });
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  pgm.dropTable('match_keys');
  pgm.dropTable('token_vault');
  pgm.dropTable('raw_transcripts');
};
