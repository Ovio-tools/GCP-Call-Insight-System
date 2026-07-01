'use strict';

/**
 * Migration 1/5 — extensions and enum types.
 *
 * Everything the later migrations depend on: the pgcrypto extension (for
 * gen_random_uuid()) and every native ENUM type. Only value sets that are FROZEN in
 * the spec become native enums; controlled vocabularies whose values are not yet
 * defined (call_status, gate_type, service_category, sentiment) stay `text` in their
 * tables and gain a CHECK/enum in the task that defines them.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MB
 */

exports.shorthands = undefined;

/** Native enum types, name -> ordered value set (all values are spec-defined). */
const ENUMS = {
  // CLAUDE.md §4 severity ladder.
  severity: ['critical', 'high', 'medium', 'low'],
  // review_queue.held_reason — every hold path in the pipeline (task spec).
  held_reason: [
    'redaction_failed',
    'residual_pii_detected',
    'classifier_uncertain',
    'malformed_model_output',
    'schema_invalid',
    'emergency_review',
    'missing_transcript',
    'cost_cap_held',
    'weak_servicetitan_match',
  ],
  // review_queue.status (task spec).
  review_status: ['open', 'in_review', 'resolved', 'unresolvable'],
  // operator_actions.action (task spec).
  operator_action: [
    'approve',
    'reject',
    'reprocess',
    'mark_non_customer',
    'mark_spam',
    'correct_extraction',
    'mark_unresolvable',
  ],
  // key_versions.status (task spec).
  key_version_status: ['active', 'rotating', 'retired', 'destroyed'],
  // raw_webhook_events.signature_status — closed set from the signature check.
  signature_status: ['valid', 'invalid', 'missing'],
  // structured_knowledge.call_intent (execution plan Task 5.2).
  call_intent: ['new_booking', 'existing_job', 'quote', 'emergency', 'billing', 'general'],
  // structured_knowledge.urgency (execution plan Task 5.2).
  urgency: ['emergency', 'urgent', 'routine'],
};

/** @param {MB} pgm */
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  for (const [name, values] of Object.entries(ENUMS)) {
    pgm.createType(name, values);
  }
};

/** @param {MB} pgm */
exports.down = (pgm) => {
  // Reverse order isn't required (enum types are independent), but the tables that
  // used them were already dropped by the later migrations' down steps.
  for (const name of Object.keys(ENUMS)) {
    pgm.dropType(name);
  }
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
