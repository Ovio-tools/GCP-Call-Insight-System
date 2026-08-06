import { type NoteFieldPath } from '../db/enums.js';
import { DISPATCH_SUMMARY_MAX_LENGTH } from '../db/schemas/technician-notes.js';
import { residualScan } from '../redaction/residual-scan.js';
import { type TechnicianNoteRecord } from './parse.js';

/**
 * Deterministic technician-note gates — a PURE module. No DB, no logger, no network.
 *
 * These are pure functions applied by the generator in a fixed order: residual scan FIRST (PII
 * precedence, and a nulled field must be able to land in the gap list), then the gap list, then
 * the length assertion.
 *
 * No gate ever returns or logs field text: counts, booleans, and constant field paths only.
 */

/**
 * The fields a dispatcher needs settled before a truck rolls. Walked in code AFTER validation to
 * build `not_established`; the model never writes that array, because a gap list the model
 * authors is a self-assessment rather than a gate.
 *
 * `scope_signal` and `occupancy` are NOT NULL enums whose vocabulary includes 'unknown', so for
 * those two "not established" means the value IS 'unknown'. For the rest it means null or empty.
 */
export const REQUIRED_FOR_DISPATCH = [
  'scope_signal',
  'equipment.type',
  'location_on_property',
  'water_status.supply_shut_off',
  'occupancy',
  'payer_authority.can_approve_work',
  'access_notes',
] as const satisfies readonly NoteFieldPath[];

/** The narrative fields that can hold free text, and therefore residual PII. */
const SCANNED_TEXT_FIELDS = [
  'symptom_verbatim',
  'access_notes',
  'prior_attempts_detail',
  'dispatch_summary',
] as const satisfies readonly NoteFieldPath[];

/** The array fields whose ELEMENTS are scanned and dropped individually. */
const SCANNED_ARRAY_FIELDS = [
  'hazards',
  'urgency_context',
] as const satisfies readonly NoteFieldPath[];

/**
 * What the residual scan did, in counts and constant ids only. This is the "counts-only redaction
 * record" the generator persists and the run aggregates — it must never be widened to carry the
 * offending text.
 */
export interface NoteResidualResult {
  /** Whether anything at all was found. */
  hit: boolean;
  /** Narrative fields set to null because they held residual PII. */
  fieldsNulled: readonly NoteFieldPath[];
  /** How many array elements were dropped, per array field. */
  elementsDropped: Readonly<Partial<Record<NoteFieldPath, number>>>;
  /** residualScan's closed category vocabulary → total count across every scanned value. */
  counts: Readonly<Record<string, number>>;
}

/** True when this single value trips the residual scan. */
function isResidualHit(value: string, denyTerms: readonly string[]): Record<string, number> | null {
  // vaultPlaintexts is empty on purpose: this job has no vault access (it can never reach DB-B),
  // exactly as the extract stage's second scan runs without it.
  const { counts } = residualScan({ redactedText: value, vaultPlaintexts: [], denyTerms });
  const nonZero = Object.entries(counts).filter(([, n]) => n > 0);
  return nonZero.length > 0 ? Object.fromEntries(nonZero) : null;
}

/**
 * Scan every free-text surface of a validated note. A hit NULLS that field (or drops that array
 * element) and is counted; it never holds the call.
 *
 * Returns a NEW record — the input is not mutated, so a caller can compare before and after.
 */
export function scanNoteForResidual(
  record: TechnicianNoteRecord,
  denyTerms: readonly string[],
): { record: TechnicianNoteRecord; residual: NoteResidualResult } {
  const counts: Record<string, number> = {};
  const fieldsNulled: NoteFieldPath[] = [];
  const elementsDropped: Partial<Record<NoteFieldPath, number>> = {};

  const merge = (found: Record<string, number>): void => {
    for (const [category, n] of Object.entries(found)) {
      counts[category] = (counts[category] ?? 0) + n;
    }
  };

  const out: TechnicianNoteRecord = { ...record };

  for (const field of SCANNED_TEXT_FIELDS) {
    const value = out[field];
    if (value === null) continue;
    const found = isResidualHit(value, denyTerms);
    if (found) {
      merge(found);
      fieldsNulled.push(field);
      out[field] = null;
    }
  }

  for (const field of SCANNED_ARRAY_FIELDS) {
    const kept: string[] = [];
    let dropped = 0;
    for (const element of out[field]) {
      const found = isResidualHit(element, denyTerms);
      if (found) {
        merge(found);
        dropped += 1;
      } else {
        kept.push(element);
      }
    }
    if (dropped > 0) {
      elementsDropped[field] = dropped;
      out[field] = kept;
    }
  }

  const hit = fieldsNulled.length > 0 || Object.keys(elementsDropped).length > 0;
  return { record: out, residual: { hit, fieldsNulled, elementsDropped, counts } };
}

/** Read a dotted note field path off a validated record. */
function valueAtPath(record: TechnicianNoteRecord, path: string): unknown {
  const [head, member] = path.split('.');
  const top = (record as unknown as Record<string, unknown>)[head as string];
  if (member === undefined) return top;
  return (top as Record<string, unknown>)[member];
}

/**
 * The gap list: which REQUIRED_FOR_DISPATCH fields the call never settled. Computed in code from
 * the validated (and residual-scanned) record, so a field nulled by the residual scan correctly
 * shows up as not established.
 */
export function computeNotEstablished(record: TechnicianNoteRecord): NoteFieldPath[] {
  const missing: NoteFieldPath[] = [];
  for (const path of REQUIRED_FOR_DISPATCH) {
    const value = valueAtPath(record, path);
    // The two NOT NULL enums express "not established" as the literal value 'unknown'.
    if (path === 'scope_signal' || path === 'occupancy') {
      if (value === 'unknown') missing.push(path);
      continue;
    }
    if (value === null || value === undefined || value === '') missing.push(path);
  }
  return missing;
}

/**
 * Defence in depth before persist. The zod cap in parse.ts already rejected an over-long summary
 * as `schema_invalid`, and the residual scan can only ever shorten it — so reaching this throw
 * means the record was built by some path that skipped validation.
 */
export function assertDispatchSummaryLength(record: TechnicianNoteRecord): void {
  const summary = record.dispatch_summary;
  if (summary !== null && summary.length > DISPATCH_SUMMARY_MAX_LENGTH) {
    throw new Error(
      `technician note dispatch_summary exceeds ${String(DISPATCH_SUMMARY_MAX_LENGTH)} characters (${String(summary.length)}) after validation`,
    );
  }
}
