import { residualScan } from '../redaction/residual-scan.js';
import { assertNoContentFields } from '../logging/redaction.js';
import {
  knowledgeExportSchema,
  knowledgeViewSchema,
  type KnowledgeExport,
  type KnowledgeRecord,
  type KnowledgeView,
} from './dto.js';

/**
 * The shared EGRESS guard for the knowledge surface (Task 10.1) — used by every output shape (HTML,
 * JSON view, JSON export, CSV, summary) through the serializers below.
 *
 * All functions here are PURE (Findings 1 & 3): no logging, no throwing on PII, no HTTP/env
 * dependency. They reuse the exact residual-scan primitive the Task 5.2 second PII scan uses. The
 * structural guard `assertNoContentFields` fires only on smuggled forbidden KEY NAMES (a coding bug),
 * not on content — the real content defense is the per-field value scan.
 *
 * `redactions` carries CATEGORIES/COUNTS ONLY, never a value — safe to log or return in a header.
 */

/** Scalar string fields scanned+scrubbed-to-null on any residual hit. */
const SCALAR_FIELDS = [
  'problem_statement',
  'location_in_home',
  'access_or_scheduling_notes',
  'prior_attempts',
  'acquisition_source',
] as const satisfies ReadonlyArray<keyof KnowledgeRecord>;

/** String-array fields scrubbed PER PHRASE (keep only zero-hit elements). */
const ARRAY_FIELDS = [
  'symptoms',
  'customer_language',
  'concerns',
  'competitor_mentions',
] as const satisfies ReadonlyArray<keyof KnowledgeRecord>;

/** Run the residual scan over one string; true iff any category hit. Merges counts into `into`. */
function scanText(
  text: string,
  denyTerms: readonly string[],
  into: Record<string, number>,
): boolean {
  const { counts } = residualScan({ redactedText: text, vaultPlaintexts: [], denyTerms });
  let hit = false;
  for (const [category, n] of Object.entries(counts)) {
    if (n > 0) {
      into[category] = (into[category] ?? 0) + n;
      hit = true;
    }
  }
  return hit;
}

/**
 * Scan the FREE-TEXT query. Pure — returns `{ safe, counts }` (never the value), never logs/throws.
 * The route throws `httpFailure('REQUEST_MALFORMED', …)` when `safe` is false so a PII-shaped `q`
 * never reflects into the response, an export link, the HTML form, or a log line (Finding 1).
 */
export function scanKnowledgeQuery(
  filters: { q?: string | undefined },
  denyTerms: readonly string[],
): { safe: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  if (filters.q !== undefined && filters.q.length > 0) {
    scanText(filters.q, denyTerms, counts);
  }
  return { safe: Object.keys(counts).length === 0, counts };
}

/**
 * Scrub one record: every scalar field with a residual hit becomes `null`; every array field keeps
 * only its zero-hit phrases. Returns the sanitized record plus counts-only `redactions`.
 */
export function sanitizeKnowledgeRecord(
  record: KnowledgeRecord,
  denyTerms: readonly string[],
): { record: KnowledgeRecord; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {};
  const out: KnowledgeRecord = { ...record };

  for (const field of SCALAR_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0 && scanText(value, denyTerms, redactions)) {
      out[field] = null;
    }
  }

  for (const field of ARRAY_FIELDS) {
    const kept: string[] = [];
    for (const phrase of record[field] as readonly string[]) {
      if (!scanText(phrase, denyTerms, redactions)) kept.push(phrase);
    }
    out[field] = kept;
  }

  return { record: out, redactions };
}

/** Sanitize every result, apply the structural backstop, then re-parse through the view schema. */
export function serializeKnowledgeView(
  view: KnowledgeView,
  denyTerms: readonly string[],
): KnowledgeView {
  const results = view.results.map((r) => sanitizeKnowledgeRecord(r, denyTerms).record);
  const dto: KnowledgeView = { ...view, results };
  assertNoContentFields(dto);
  return knowledgeViewSchema.parse(dto);
}

/** Sanitize every result, apply the structural backstop, then re-parse through the export schema. */
export function serializeKnowledgeExport(
  exportDto: KnowledgeExport,
  denyTerms: readonly string[],
): KnowledgeExport {
  const results = exportDto.results.map((r) => sanitizeKnowledgeRecord(r, denyTerms).record);
  const dto: KnowledgeExport = { ...exportDto, results };
  assertNoContentFields(dto);
  return knowledgeExportSchema.parse(dto);
}
