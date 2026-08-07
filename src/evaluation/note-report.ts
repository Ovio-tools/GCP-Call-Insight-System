import { NOTE_FEEDBACK_VERDICTS, NOTE_FIELD_PATHS, type NoteFeedbackVerdict } from '../db/enums.js';
import type { NoteFeedbackRow } from '../db/schemas/note-feedback.js';
import { compareStrings, resolveStanding } from './note-label.js';
import { NOTE_EVAL_SET_VERSION } from './version.js';

/**
 * The technician-note quality report (Task 6.3, extended to `note_feedback`). PURE — no DB, no
 * network, no clock (the caller injects `now`). The DB read lives in the CLI entrypoint.
 *
 * Three outputs, each answering a question one aggregate accuracy number cannot:
 *
 *  1. AGREEMENT PER FIELD PATH — which fields the model actually gets wrong. "The notes are 82%
 *     right" is unactionable; "we get `occupancy` wrong two times in three" points at a prompt fix.
 *  2. THE MOST FREQUENT `not_established` ENTRIES — the highest-value output of the whole feature,
 *     and the one that is not about the model at all. `not_established` is computed in code from
 *     `REQUIRED_FOR_DISPATCH`, so a field high on this list means the PHONE INTAKE keeps failing to
 *     ask that question. That is a call-script change, and it is worth more to the business than
 *     the notes themselves: every entry is a truck roll that starts with a technician phoning the
 *     customer to ask what should already have been on the ticket.
 *  3. AGREEMENT BY PROMPT VERSION — so a prompt change can be SHOWN to have helped or not, rather
 *     than argued about. Verdicts stay attached to the version they were given against, which is
 *     why a regenerated note never invalidates the old version's numbers.
 *
 * WHAT IS COUNTED. One observation per STANDING verdict — the latest row per `(call_id,
 * note_prompt_version, field_path, reviewer_actor)`, the same resolution `getLatestNoteFeedback`
 * applies in SQL. A revised verdict counts once, at its latest value. A field NOBODY judged is
 * absent everywhere: silence is not agreement.
 *
 * NO PII, BY CONSTRUCTION. Every string this report can emit is a controlled value — a note field
 * path, a verdict name, or a prompt version (a code/config constant). Call ids, reviewer
 * identities, and note text never enter it. `not_established` entries are re-checked against
 * `NOTE_FIELD_PATHS` and anything unrecognized is COUNTED, not printed, so a hand-written jsonb
 * array cannot smuggle a string into the output. `test/evaluation/note-report.test.ts` runs
 * `residualScan` over the fully rendered text.
 */

/** Rank of a field path in the canonical note layout — a stable secondary sort key. */
const FIELD_ORDER = new Map<string, number>(NOTE_FIELD_PATHS.map((p, i) => [p, i]));
const KNOWN_FIELD_PATHS = new Set<string>(NOTE_FIELD_PATHS);

/** One stored note, as the gap count reads it. */
export interface NoteGapRow {
  prompt_version: string;
  not_established: string[];
}

export interface NoteReportInput {
  /** EVERY `note_feedback` row — append-only; the standing resolution happens here. */
  feedback: readonly NoteFeedbackRow[];
  /** Every visible (non-superseded) stored note, for the `not_established` frequency count. */
  notes: readonly NoteGapRow[];
  now: Date;
}

export interface NoteFieldAgreement {
  field_path: string;
  verdicts: number;
  correct: number;
  agreement: number;
  wrong: number;
  missing: number;
  should_not_be_here: number;
  /** Standing verdicts that carried a corrected controlled value (free-text fields never do). */
  corrections: number;
}

export interface NotePromptVersionAgreement {
  prompt_version: string;
  verdicts: number;
  correct: number;
  agreement: number;
  /** Distinct calls with at least one standing verdict at this version. */
  notes_reviewed: number;
  /** Distinct field paths judged at this version. */
  fields_reviewed: number;
}

export interface NotEstablishedFrequency {
  field_path: string;
  notes: number;
  share: number;
}

export interface NoteQualityReport {
  generated_at: Date;
  note_eval_set_version: number;
  notes_total: number;
  notes_with_gaps: number;
  calls_reviewed: number;
  standing_verdicts: number;
  by_field: NoteFieldAgreement[];
  by_prompt_version: NotePromptVersionAgreement[];
  not_established: NotEstablishedFrequency[];
  /** `not_established` entries that are not known field paths — counted, never printed. */
  unrecognized_not_established: number;
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function isKnownFieldPath(path: string): boolean {
  return KNOWN_FIELD_PATHS.has(path);
}

/** Field rank, unknown paths last (the column is enum-checked, but the comparator must be total). */
function fieldRank(path: string): number {
  return FIELD_ORDER.get(path) ?? NOTE_FIELD_PATHS.length;
}

/** Per-verdict counter. A switch over the closed vocabulary, so a new verdict member is a compile
 * error here rather than a silently uncounted column. */
function bumpVerdict(field: NoteFieldAgreement, verdict: NoteFeedbackVerdict): void {
  switch (verdict) {
    case 'correct':
      field.correct += 1;
      return;
    case 'wrong':
      field.wrong += 1;
      return;
    case 'missing':
      field.missing += 1;
      return;
    case 'should_not_be_here':
      field.should_not_be_here += 1;
      return;
  }
}

/**
 * How many NOTES list each field as not established. Counted per note, not per occurrence: the
 * array is a set of gaps, so a duplicated entry in a hand-written row must not double-count.
 * Anything outside `NOTE_FIELD_PATHS` is counted as unrecognized and never printed.
 */
function countNotEstablished(notes: readonly NoteGapRow[]): {
  frequencies: NotEstablishedFrequency[];
  unrecognized: number;
} {
  const counts = new Map<string, number>();
  let unrecognized = 0;
  for (const note of notes) {
    const seen = new Set<string>();
    for (const entry of note.not_established) {
      if (!isKnownFieldPath(entry)) {
        unrecognized += 1;
        continue;
      }
      if (seen.has(entry)) continue;
      seen.add(entry);
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
  }
  const frequencies = [...counts.entries()]
    .map(([field_path, count]) => ({
      field_path,
      notes: count,
      share: ratio(count, notes.length),
    }))
    .sort((a, b) => b.notes - a.notes || fieldRank(a.field_path) - fieldRank(b.field_path));
  return { frequencies, unrecognized };
}

export function buildNoteQualityReport(input: NoteReportInput): NoteQualityReport {
  // JSON, not a delimiter-joined string: `reviewer_actor` is an authenticated subject and may
  // itself contain the delimiter, which would silently merge two reviewers into one key.
  const standing = resolveStanding(input.feedback, (r) =>
    JSON.stringify([r.call_id, r.note_prompt_version, r.field_path, r.reviewer_actor]),
  );

  const byField = new Map<string, NoteFieldAgreement>();
  const byVersion = new Map<
    string,
    { tally: NotePromptVersionAgreement; calls: Set<string>; fields: Set<string> }
  >();

  for (const row of standing) {
    let field = byField.get(row.field_path);
    if (!field) {
      field = {
        field_path: row.field_path,
        verdicts: 0,
        correct: 0,
        agreement: 0,
        wrong: 0,
        missing: 0,
        should_not_be_here: 0,
        corrections: 0,
      };
      byField.set(row.field_path, field);
    }
    field.verdicts += 1;
    bumpVerdict(field, row.verdict);
    if (row.corrected_enum_value !== null) field.corrections += 1;

    let version = byVersion.get(row.note_prompt_version);
    if (!version) {
      version = {
        tally: {
          prompt_version: row.note_prompt_version,
          verdicts: 0,
          correct: 0,
          agreement: 0,
          notes_reviewed: 0,
          fields_reviewed: 0,
        },
        calls: new Set(),
        fields: new Set(),
      };
      byVersion.set(row.note_prompt_version, version);
    }
    version.tally.verdicts += 1;
    if (row.verdict === 'correct') version.tally.correct += 1;
    version.calls.add(row.call_id);
    version.fields.add(row.field_path);
  }

  for (const field of byField.values()) field.agreement = ratio(field.correct, field.verdicts);
  for (const v of byVersion.values()) {
    v.tally.agreement = ratio(v.tally.correct, v.tally.verdicts);
    v.tally.notes_reviewed = v.calls.size;
    v.tally.fields_reviewed = v.fields.size;
  }

  const gaps = countNotEstablished(input.notes);

  return {
    generated_at: input.now,
    note_eval_set_version: NOTE_EVAL_SET_VERSION,
    notes_total: input.notes.length,
    notes_with_gaps: input.notes.filter((n) => n.not_established.some(isKnownFieldPath)).length,
    calls_reviewed: new Set(standing.map((r) => r.call_id)).size,
    standing_verdicts: standing.length,
    // Worst agreement first — the point of the per-field breakdown is to name what to fix.
    by_field: [...byField.values()].sort(
      (a, b) =>
        a.agreement - b.agreement ||
        b.verdicts - a.verdicts ||
        fieldRank(a.field_path) - fieldRank(b.field_path),
    ),
    by_prompt_version: [...byVersion.values()]
      .map((v) => v.tally)
      .sort((a, b) => compareStrings(a.prompt_version, b.prompt_version)),
    not_established: gaps.frequencies,
    unrecognized_not_established: gaps.unrecognized,
  };
}

// --- Rendering ---------------------------------------------------------------------------------
//
// The rendered text is read in a terminal and pasted into a message, so it is plain text with no
// escaping rules of its own.
//
// TWO FORMATTING INVARIANTS, and they are privacy invariants rather than cosmetic ones.
// `residualScan` strips every non-alphanumeric before looking for a run of >= 7 digits, so:
//
//  1. EVERY NUMBER IS PRECEDED BY A LABEL WORD, AND EVERY LINE BEGINS WITH A WORD — otherwise two
//     numeric columns printed side by side ("15  4321") concatenate into one 6-digit run, and a
//     third column tips it over. This is also why the timestamp is rendered `2026-Aug-07 at 12:00
//     UTC` rather than as an ISO instant (`20260807T…` is an 8-digit run all by itself).
//  2. NO SINGLE NUMBER EVER REACHES 7 DIGITS — see {@link num}, which scales anything past a
//     million to a unit-suffixed form (`9.88M`). A count is not PII, but a scanner cannot tell,
//     and a report that trips the very scan the pipeline relies on would teach everyone reading it
//     to ignore a hit.
//
// `test/evaluation/note-report.test.ts` pins both by scanning the rendered output, including at
// counts far larger than this business will ever produce.

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `2026-Aug-07 at 12:00 UTC` — letters between every digit group (see the invariant above). */
function formatStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const month = MONTHS[at.getUTCMonth()] ?? 'Jan';
  const day = pad(at.getUTCDate());
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  return `${String(at.getUTCFullYear())}-${month}-${day} at ${time} UTC`;
}

/** `73.3%`, one decimal place — at most four digits. */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Scale thresholds, largest first. `1e15` covers every safe integer, so `num` is total. */
const SCALES = [
  [1e15, 'P'],
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
] as const;

/**
 * A count, formatted so its digit run can never reach seven (invariant 2 above). Under a million
 * it is the plain number; past that it is scaled to two decimals with a unit letter (`9.88M`),
 * which caps any safe integer at six digits and reads better in a terminal besides.
 */
function num(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1e6) return String(value);
  for (const [factor, suffix] of SCALES) {
    if (abs >= factor) return `${(value / factor).toFixed(2)}${suffix}`;
  }
  return String(value);
}

/** Width of the leading label column, bounded so one odd value cannot wreck the layout. */
function columnWidth(values: readonly string[]): number {
  return Math.min(40, Math.max(0, ...values.map((v) => v.length)));
}

/** The verdict vocabulary, spelled out once for the reader of the rendered report. */
const VERDICT_LEGEND = `verdicts are ${NOTE_FEEDBACK_VERDICTS.join(', ').replace(/_/g, '-')}`;

export function renderNoteQualityReport(report: NoteQualityReport): string {
  const lines: string[] = [];
  lines.push('Technician-note quality report');
  lines.push(`generated ${formatStamp(report.generated_at)}`);
  lines.push(
    `label set version ${num(report.note_eval_set_version)}  notes stored ${num(report.notes_total)}  ` +
      `calls reviewed ${num(report.calls_reviewed)}  standing verdicts ${num(report.standing_verdicts)}`,
  );

  lines.push('');
  lines.push('What the phone intake keeps failing to establish');
  lines.push('  (how many stored notes list each field as not established)');
  if (report.not_established.length === 0) {
    lines.push('  no gaps recorded across the stored notes');
  } else {
    const width = columnWidth(report.not_established.map((g) => g.field_path));
    for (const gap of report.not_established) {
      lines.push(
        `  ${gap.field_path.padEnd(width)}  notes ${num(gap.notes)} of ${num(report.notes_total)}  share ${pct(gap.share)}`,
      );
    }
    lines.push(
      `  notes with at least one gap ${num(report.notes_with_gaps)} of ${num(report.notes_total)}`,
    );
  }
  if (report.unrecognized_not_established > 0) {
    lines.push(
      `  unrecognized entries skipped ${num(report.unrecognized_not_established)} (not known note field paths)`,
    );
  }

  lines.push('');
  lines.push('Agreement per field, worst first');
  lines.push(`  (a field is listed only where a reviewer judged it; ${VERDICT_LEGEND})`);
  if (report.by_field.length === 0) {
    lines.push('  no verdicts recorded yet');
  } else {
    const width = columnWidth(report.by_field.map((f) => f.field_path));
    for (const field of report.by_field) {
      lines.push(
        `  ${field.field_path.padEnd(width)}  agreement ${pct(field.agreement)}  verdicts ${num(field.verdicts)}  ` +
          `correct ${num(field.correct)}  wrong ${num(field.wrong)}  missing ${num(field.missing)}  ` +
          `should-not-be-here ${num(field.should_not_be_here)}  corrections ${num(field.corrections)}`,
      );
    }
  }

  lines.push('');
  lines.push('Agreement by note prompt version');
  lines.push('  (verdicts stay attached to the version they were given against)');
  if (report.by_prompt_version.length === 0) {
    lines.push('  no verdicts recorded yet');
  } else {
    const width = columnWidth(report.by_prompt_version.map((v) => v.prompt_version));
    for (const version of report.by_prompt_version) {
      lines.push(
        `  ${version.prompt_version.padEnd(width)}  agreement ${pct(version.agreement)}  ` +
          `verdicts ${num(version.verdicts)}  correct ${num(version.correct)}  ` +
          `notes ${num(version.notes_reviewed)}  fields ${num(version.fields_reviewed)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
