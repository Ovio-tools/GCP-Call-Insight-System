import { z } from 'zod';
import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_CORRECTABLE_VALUES,
  NOTE_EQUIPMENT_KEYS,
  NOTE_FIELD_PATHS,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
  noteFeedbackVerdictSchema,
  noteFieldPathSchema,
  type NoteFieldPath,
} from '../db/enums.js';
import { fillNulls } from '../db/schemas/technician-notes.js';
import type { NoteFeedbackRow } from '../db/schemas/note-feedback.js';
import type { TechnicianNoteRow } from '../db/schemas/technician-notes.js';
import {
  technicianNoteRecordSchema,
  type TechnicianNoteRecord,
} from '../technician-notes/parse.js';

/**
 * Pure note-label builders (Task 6.3, extended to `note_feedback`): turn append-only reviewer
 * verdicts on technician-note fields into a labeled example. NO DB, NO network, NO PII — the only
 * text path (the redacted transcript) is handled by the fixture export, not here.
 *
 * WHY THIS SHAPE DIFFERS FROM `labeled_examples`. A `correct_extraction` review action carries a
 * full corrected record, so an extract label can pin all four controlled enums at once. A note
 * verdict is per FIELD: a reviewer marks `equipment.type` wrong and says nothing at all about the
 * other thirty-five fields. So a note label is a set of FIELD-LEVEL ASSERTIONS, never a full
 * expected record — and a field with no verdict is ABSENT from the expected output rather than
 * assumed correct. Treating silence as agreement would invent ground truth nobody gave and would
 * inflate every accuracy number the reviewers are meant to be measuring.
 *
 * NO TABLE, NO MIGRATION. `labeled_examples` exists because its inputs (`clean_transcripts`) are
 * purgeable, so a label must be captured before its source disappears. Both inputs here —
 * `technician_notes` and `note_feedback` — are never purged (ADR 0009), so a note label stays
 * derivable from stored rows forever and persisting a copy would only add a second source of
 * truth to keep in sync. That is also what makes the fixtures reproducible with no model call.
 *
 * The expected-output shapes live here rather than in `src/db/schemas/` because no table backs
 * them; a schema module there names a real table's columns.
 */

/** Position of a field path in the canonical note layout — the sort key for every list here. */
const FIELD_ORDER = new Map<string, number>(NOTE_FIELD_PATHS.map((p, i) => [p, i]));

/**
 * One reviewer assertion about one note field. `corrected_enum_value` is present only where the
 * reviewer gave one — free-text fields (a brand, a symptom in the caller's words) admit no
 * correction at all, so a `wrong` verdict on those is the whole assertion.
 *
 * `contested` records that two reviewers hold DIFFERENT standing verdicts on this field. The
 * latest one wins (it is the freshest human judgement), but the disagreement is surfaced rather
 * than silently dropped: a contested field is exactly the kind of thing an accuracy number should
 * not quietly average away. Reviewer identities are deliberately NOT carried into a fixture file.
 */
export const noteFieldAssertionSchema = z
  .object({
    field_path: noteFieldPathSchema,
    verdict: noteFeedbackVerdictSchema,
    corrected_enum_value: z.string().nullable(),
    contested: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.corrected_enum_value === null) return;
    const allowed = NOTE_CORRECTABLE_VALUES[v.field_path];
    if (!allowed?.includes(v.corrected_enum_value)) {
      // The offending value is NOT echoed — mirrors `recordNoteFeedbackInputSchema`.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['corrected_enum_value'],
        message: `corrected value is not in the controlled list for field_path ${v.field_path}`,
      });
    }
  });
export type NoteFieldAssertion = z.infer<typeof noteFieldAssertionSchema>;

/**
 * A note label's expected output: the asserted fields ONLY, in canonical note order. An empty
 * `assertions` array is not a valid label — a call with no verdicts is not an example.
 */
export const expectedNoteOutputSchema = z
  .object({ assertions: z.array(noteFieldAssertionSchema).min(1) })
  .strict();
export type ExpectedNoteOutput = z.infer<typeof expectedNoteOutputSchema>;

/** The append-only columns the standing-verdict resolution needs. */
export type StandingCandidate = Pick<
  NoteFeedbackRow,
  'field_path' | 'verdict' | 'corrected_enum_value' | 'reviewer_actor' | 'created_at' | 'id'
>;

/**
 * Resolve an append-only set of rows to the STANDING row per key: the newest by
 * `(created_at, id)`, exactly the tie-break `getLatestNoteFeedback` applies in SQL (`created_at
 * DESC, id DESC`), so a revision written in the same transaction as the verdict it replaces still
 * resolves to the later insert. Returns the winners ordered by key, so the output is stable
 * whatever order the rows arrived in.
 *
 * Generic because the report resolves per `(call_id, prompt_version, field_path, reviewer)` while
 * a single call's label resolves per `(field_path, reviewer)` — one rule, two scopes.
 */
export function resolveStanding<T extends { created_at: Date; id: string }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  const winners = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const held = winners.get(key);
    if (held === undefined || isNewer(row, held)) winners.set(key, row);
  }
  return [...winners.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, r]) => r);
}

/** Byte-order string compare — never `localeCompare`, whose order depends on the runtime locale
 * and would make a "deterministic" ordering environment-dependent. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** `created_at` first, `id` as the deterministic tie-break. */
function isNewer(
  a: { created_at: Date; id: string },
  b: { created_at: Date; id: string },
): boolean {
  const at = a.created_at.getTime();
  const bt = b.created_at.getTime();
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

/**
 * Build the field-level assertions for ONE call at ONE note prompt version.
 *
 * Two resolutions, in order: the standing verdict per `(field_path, reviewer_actor)` — so a
 * reviewer who changed their mind counts once, at the latest value — and then, where several
 * reviewers hold a standing verdict on the same field, the newest of those becomes the assertion
 * and the field is marked `contested` if they do not agree.
 *
 * Rows for other calls or other prompt versions must be filtered out by the caller: a verdict
 * given against v1 says nothing about the v2 note that replaced it.
 */
export function buildNoteAssertions(rows: readonly StandingCandidate[]): NoteFieldAssertion[] {
  const standing = resolveStanding(rows, (r) => JSON.stringify([r.field_path, r.reviewer_actor]));

  const byField = new Map<NoteFieldPath, StandingCandidate[]>();
  for (const row of standing) {
    const held = byField.get(row.field_path);
    if (held) held.push(row);
    else byField.set(row.field_path, [row]);
  }

  const assertions: NoteFieldAssertion[] = [];
  for (const [field_path, group] of byField) {
    let winner = group[0]!;
    let contested = false;
    for (const row of group.slice(1)) {
      if (
        row.verdict !== winner.verdict ||
        row.corrected_enum_value !== winner.corrected_enum_value
      )
        contested = true;
      if (isNewer(row, winner)) winner = row;
    }
    assertions.push({
      field_path,
      verdict: winner.verdict,
      corrected_enum_value: winner.corrected_enum_value,
      contested,
    });
  }

  return assertions.sort(
    (a, b) => (FIELD_ORDER.get(a.field_path) ?? 0) - (FIELD_ORDER.get(b.field_path) ?? 0),
  );
}

/**
 * Project a STORED note row back into the wire record a correct model returns for it — the note
 * equivalent of `buildExtractRecord`, and what makes a fixture reproducible with no live model
 * call. `call_id`, the versions, the retention triplet, and `not_established` are all dropped:
 * `not_established` is computed in code by `computeNotEstablished`, so a model that volunteers one
 * fails `.strict()` and a fixture that carried one would teach the wrong contract.
 *
 * Every jsonb group is rebuilt from its KEY TUPLE (`fillNulls`) rather than spread, so the key
 * order is the canonical one whatever order Postgres handed the object back in — that is what
 * makes `JSON.stringify` of this record byte-stable across rebuilds.
 *
 * The schema gate is `technicianNoteRecordSchema`, the same gate the note generator applies. A
 * stored row that no longer validates (a vocabulary tightened since it was written) yields
 * `{ok:false}` so the caller records a content-free skip rather than exporting a bad fixture.
 */
export function noteRecordFromRow(
  row: TechnicianNoteRow,
): { ok: true; record: TechnicianNoteRecord } | { ok: false } {
  const candidate = {
    scope_signal: row.scope_signal,
    occupancy: row.occupancy,
    equipment: fillNulls(NOTE_EQUIPMENT_KEYS, row.equipment),
    system_context: fillNulls(NOTE_SYSTEM_CONTEXT_KEYS, row.system_context),
    water_status: fillNulls(NOTE_WATER_STATUS_KEYS, row.water_status),
    payer_authority: fillNulls(NOTE_PAYER_AUTHORITY_KEYS, row.payer_authority),
    prior_work: fillNulls(NOTE_PRIOR_WORK_KEYS, row.prior_work),
    commitments_made: fillNulls(NOTE_COMMITMENTS_MADE_KEYS, row.commitments_made),
    location_on_property: row.location_on_property,
    symptom_verbatim: row.symptom_verbatim,
    prior_attempts_detail: row.prior_attempts_detail,
    access_notes: row.access_notes,
    hazards: row.hazards,
    urgency_context: row.urgency_context,
    dispatch_summary: row.dispatch_summary,
  };
  const parsed = technicianNoteRecordSchema.safeParse(candidate);
  return parsed.success ? { ok: true, record: parsed.data } : { ok: false };
}
