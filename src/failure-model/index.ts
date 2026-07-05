/**
 * Shared failure-model modules (CLAUDE.md §4 / build plan §2.7): the canonical home for
 * the operational failure model — typed error, root-cause taxonomy, severity map, static
 * remediation catalog (no generic UNKNOWN fallback), PII-safe alert formatter, dedup key,
 * and unacknowledged-critical escalation.
 */
export * from './categories.js';
export * from './catalog.js';
export * from './severity.js';
export * from './error.js';
export * from './snapshot.js';
export * from './dedup.js';
export * from './alert.js';
export * from './render-row.js';
export * from './escalation.js';
