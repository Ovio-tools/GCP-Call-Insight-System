import { residualScan } from '../redaction/residual-scan.js';
import { assertNoContentFields } from '../logging/redaction.js';
import {
  noteDetailSchema,
  noteListSchema,
  noteTranscriptSchema,
  type NoteDetail,
  type NoteList,
  type NoteTranscript,
} from './dto.js';

/**
 * The EGRESS guards for the note-review surface (ADR 0009).
 *
 * All functions here are PURE: no logging, no throwing on PII, no HTTP/env dependency. They reuse
 * the exact `residualScan` primitive the Task 5.2 second PII scan and the knowledge surface use.
 *
 * There are TWO serializers with deliberately different postures, and the difference is the whole
 * design of this module — see {@link serializeTranscript}.
 */

/** Note fields that are free text and therefore scanned + scrubbed on egress. Mirrors
 * `SCANNED_TEXT_FIELDS` in `src/technician-notes/gates.ts`, plus `location_on_property`, which the
 * write-time scan does not cover — a note stored before this surface existed never had it checked. */
const DETAIL_SCALAR_FIELDS = [
  'location_on_property',
  'symptom_verbatim',
  'prior_attempts_detail',
  'access_notes',
  'dispatch_summary',
] as const satisfies ReadonlyArray<keyof NoteDetail>;

/** String-array note fields, scrubbed PER ELEMENT (keep only zero-hit entries). */
const DETAIL_ARRAY_FIELDS = ['hazards', 'urgency_context'] as const satisfies ReadonlyArray<
  keyof NoteDetail
>;

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
 * The FREE-TEXT filter keys — the ones a user can put arbitrary characters into, and which are
 * therefore worth a value-level scan before they reflect into a response, the filter form, a pager
 * href, or a log line. `scanNoteQuery` scans exactly these.
 *
 * The list is EMPTY today, and that is a finding rather than an oversight. Every filter this
 * surface accepts is either a controlled vocabulary (`service_category`, `urgency`,
 * `review_state` — zod enums, so an off-vocabulary value is already `REQUEST_MALFORMED`) or a date
 * bound matched against an anchored `YYYY-MM-DD` / ISO-8601 pattern AND checked for calendar
 * overflow. A string that has passed those cannot carry a name, an address, or a phone number.
 *
 * The date bounds are excluded DELIBERATELY, not by omission: `residualScan` reports a `digit_run`
 * for `2026-07-12`, because a date is structurally indistinguishable from one. Scanning them would
 * reject every legitimate date range while protecting nothing — a guard that only ever fires on
 * correct input. (A real Dialpad `call_id` is a digit run for the same reason, which is why the
 * detail routes do not scan theirs either; what protects a `call_id` on its way into the page is
 * `esc`, and what protects it from a query is the parameterized SQL.)
 *
 * The hook stays wired at the same point in the pipeline the knowledge surface uses so that adding
 * a free-text filter later (a `q` over dispatch summaries, say) means adding ONE key here rather
 * than rediscovering that the scan needs to exist.
 */
const FREE_TEXT_FILTER_KEYS: readonly string[] = [];

/**
 * Scan the free-text filter values. Pure — returns `{ safe, counts }` (never the value), never logs
 * and never throws. The route turns `safe: false` into `REQUEST_MALFORMED` BEFORE any DB read, the
 * same ordering as `src/knowledge/routes.ts:78-83`.
 */
export function scanNoteQuery(
  filters: Readonly<Record<string, string | undefined>>,
  denyTerms: readonly string[],
): { safe: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const key of FREE_TEXT_FILTER_KEYS) {
    const value = filters[key];
    if (typeof value === 'string' && value.length > 0) scanText(value, denyTerms, counts);
  }
  return { safe: Object.keys(counts).length === 0, counts };
}

/** The scanning machinery `scanNoteQuery` uses, exposed so its behaviour is testable while
 * {@link FREE_TEXT_FILTER_KEYS} is empty — otherwise the guard could rot into a no-op unnoticed and
 * be discovered only by the first free-text filter that needed it. */
export function scanFreeTextValue(
  value: string,
  denyTerms: readonly string[],
): { safe: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  scanText(value, denyTerms, counts);
  return { safe: Object.keys(counts).length === 0, counts };
}

/**
 * Scrub one note detail: every free-text scalar with a residual hit becomes `null`; every array
 * keeps only its zero-hit elements. Returns the sanitized note plus counts-only `redactions`.
 *
 * A scrubbed field still renders — as "not stated on the call", the same treatment a genuinely
 * absent field gets. That is the honest outcome here: the reviewer is told the field carries
 * nothing they can judge, and no un-scanned text reaches the page either way.
 */
export function sanitizeNoteDetail(
  note: NoteDetail,
  denyTerms: readonly string[],
): { note: NoteDetail; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {};
  const out: NoteDetail = { ...note };

  for (const field of DETAIL_SCALAR_FIELDS) {
    const value = note[field];
    if (typeof value === 'string' && value.length > 0 && scanText(value, denyTerms, redactions)) {
      out[field] = null;
    }
  }

  for (const field of DETAIL_ARRAY_FIELDS) {
    out[field] = note[field].filter((entry) => !scanText(entry, denyTerms, redactions));
  }

  return { note: out, redactions };
}

/** Sanitize every list row's summary line, apply the structural backstop, re-parse through the
 * schema. The list carries no other free text — category/urgency/state are enums, and the counts
 * are integers. */
export function serializeNoteList(list: NoteList, denyTerms: readonly string[]): NoteList {
  const results = list.results.map((r) => {
    const line = r.dispatch_summary_first_line;
    if (line === null || line.length === 0) return r;
    return scanText(line, denyTerms, {}) ? { ...r, dispatch_summary_first_line: null } : r;
  });
  const dto: NoteList = { ...list, results };
  assertNoContentFields(dto);
  return noteListSchema.parse(dto);
}

/** Sanitize the note, apply the structural backstop, re-parse through the detail schema. */
export function serializeNoteDetail(note: NoteDetail, denyTerms: readonly string[]): NoteDetail {
  const dto = sanitizeNoteDetail(note, denyTerms).note;
  assertNoContentFields(dto);
  return noteDetailSchema.parse(dto);
}

/**
 * Serialize the transcript response — the ONE payload on this surface that deliberately carries
 * conversation text.
 *
 * Two things differ from every serializer above, both on purpose:
 *
 * 1. NO `assertNoContentFields`. That guard asserts no content-shaped KEY NAME appears in an egress
 *    DTO; its premise is that such a name indicates a coding bug, because no DTO should be shipping
 *    content. This one is shipping content by design, so the premise does not hold. `redacted_text`
 *    is not on the ban list (matching there is exact, not substring), so the guard would PASS — and
 *    a guard that passes only by virtue of a naming choice is false assurance about precisely the
 *    payload that most needs a real one. Omitted rather than kept as decoration.
 *
 * 2. It fails CLOSED on the whole body, not per field. `sanitizeNoteDetail` above nulls the
 *    offending field and returns the rest, which is right for a record of many small fields. A
 *    transcript is one field: a hit anywhere means the redaction we are relying on did not hold, so
 *    the correct response is to send NO transcript, not a partially-trusted one. That is why
 *    `withheld` exists as a state distinct from `unavailable` — the reviewer is told the difference
 *    between "there is nothing stored" and "we are not showing you what is stored".
 */
export function serializeTranscript(
  redactedText: string | undefined,
  denyTerms: readonly string[],
): NoteTranscript {
  if (redactedText === undefined) {
    return noteTranscriptSchema.parse({ available: false, reason: 'unavailable' });
  }
  if (scanText(redactedText, denyTerms, {})) {
    return noteTranscriptSchema.parse({ available: false, reason: 'withheld' });
  }
  return noteTranscriptSchema.parse({ available: true, redacted_text: redactedText });
}
