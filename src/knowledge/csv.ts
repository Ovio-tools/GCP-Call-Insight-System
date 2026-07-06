import type { KnowledgeRecord } from './dto.js';

/**
 * PURE CSV builder for the knowledge export (Task 10.1). No `denyTerms`, no PII logic — sanitizing
 * is the serializer's job (Finding 5); this module faithfully escapes whatever records it is given.
 * The body is strictly `header + record rows` — never a note/truncation row (Finding 3); truncation
 * is signalled by the CSV `X-Export-*` response headers only.
 */

/** The stable CSV header = the allowlisted record columns, in canonical order. */
export const KNOWLEDGE_CSV_COLUMNS = [
  'call_id',
  'created_at',
  'call_intent',
  'service_category',
  'urgency',
  'problem_statement',
  'symptoms',
  'customer_language',
  'concerns',
  'competitor_mentions',
  'acquisition_source',
  'location_in_home',
  'access_or_scheduling_notes',
  'prior_attempts',
] as const satisfies ReadonlyArray<keyof KnowledgeRecord>;

/**
 * A leading tab/CR/LF is ALWAYS neutralized; a formula lead char (`= + - @`) is neutralized even
 * behind optional leading spaces (Finding 4). Spreadsheet apps treat all of these as formula/command
 * starters, so a single-quote prefix defuses them.
 */
const FORMULA_INJECTION = /^(?:[\t\r\n]| *[=+\-@])/;

/** Escape one value into a CSV cell. Array → `; `-joined, null/undefined → empty (done FIRST). */
export function toCsvCell(value: string | readonly string[] | null | undefined): string {
  let cell: string;
  if (Array.isArray(value)) {
    cell = value.join('; ');
  } else if (value === null || value === undefined) {
    cell = '';
  } else {
    cell = String(value);
  }

  // Formula-injection guard, applied to the joined/null-converted cell.
  if (FORMULA_INJECTION.test(cell)) {
    cell = `'${cell}`;
  }

  // Quote iff the cell contains a comma, quote, CR, or newline; double internal quotes.
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** Build the full CSV: header row then one row per record, columns in {@link KNOWLEDGE_CSV_COLUMNS} order. */
export function buildKnowledgeCsv(records: readonly KnowledgeRecord[]): string {
  const header = KNOWLEDGE_CSV_COLUMNS.join(',');
  const rows = records.map((r) => KNOWLEDGE_CSV_COLUMNS.map((col) => toCsvCell(r[col])).join(','));
  return [header, ...rows].join('\n');
}
