import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_NON_DISPATCH_INTENTS,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
} from '../enums.js';
import {
  type TechnicianNoteInsert,
  type TechnicianNoteRow,
  fillNulls,
  technicianNoteInsertSchema,
  technicianNoteRowSchema,
} from '../schemas/technician-notes.js';

const TABLE = 'technician_notes';

/**
 * Idempotent upsert keyed on call_id — the current job-readiness note for a call. Re-running the
 * note stage REPLACES the note rather than accumulating rows; there is exactly one current note.
 *
 * Unlike `upsertCleanTranscript` there is no hard-delete guard: `technician_notes` is never purged
 * (ADR 0009), so `hard_deleted_at` is always NULL and a guard would be dead code that reads as if
 * a retention conflict were possible here.
 *
 * Takes a {@link Queryable} so the write can enlist in the same transaction as the pipeline state
 * change that produced it — no note without its stage advance, and no advance without its note.
 */
export async function upsertTechnicianNote(
  db: Queryable,
  input: TechnicianNoteInsert,
): Promise<TechnicianNoteRow> {
  const v = parseOrThrow(TABLE, technicianNoteInsertSchema, input);
  const rows = await query<TechnicianNoteRow>(
    db,
    `INSERT INTO technician_notes (
       call_id, prompt_version, model_id, schema_version, scope_signal,
       equipment, system_context, water_status, payer_authority, prior_work,
       location_on_property, symptom_verbatim, prior_attempts_detail, access_notes,
       hazards, urgency_context, commitments_made, occupancy, not_established, dispatch_summary)
     VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
       $11, $12, $13, $14,
       COALESCE($15::jsonb, '[]'::jsonb), COALESCE($16::jsonb, '[]'::jsonb),
       $17::jsonb, $18, COALESCE($19::jsonb, '[]'::jsonb), $20)
     ON CONFLICT (call_id) DO UPDATE SET
       prompt_version = EXCLUDED.prompt_version,
       model_id = EXCLUDED.model_id,
       schema_version = EXCLUDED.schema_version,
       scope_signal = EXCLUDED.scope_signal,
       equipment = EXCLUDED.equipment,
       system_context = EXCLUDED.system_context,
       water_status = EXCLUDED.water_status,
       payer_authority = EXCLUDED.payer_authority,
       prior_work = EXCLUDED.prior_work,
       location_on_property = EXCLUDED.location_on_property,
       symptom_verbatim = EXCLUDED.symptom_verbatim,
       prior_attempts_detail = EXCLUDED.prior_attempts_detail,
       access_notes = EXCLUDED.access_notes,
       hazards = EXCLUDED.hazards,
       urgency_context = EXCLUDED.urgency_context,
       commitments_made = EXCLUDED.commitments_made,
       occupancy = EXCLUDED.occupancy,
       not_established = EXCLUDED.not_established,
       dispatch_summary = EXCLUDED.dispatch_summary
     RETURNING *`,
    [
      v.callId,
      v.promptVersion,
      v.modelId,
      v.schemaVersion,
      v.scopeSignal,
      // fillNulls, not COALESCE: the stored object always carries EVERY key, so the strict row
      // schema parses whatever comes back and a later key addition is visibly absent, not missing.
      toJsonParam(fillNulls(NOTE_EQUIPMENT_KEYS, v.equipment)),
      toJsonParam(fillNulls(NOTE_SYSTEM_CONTEXT_KEYS, v.systemContext)),
      toJsonParam(fillNulls(NOTE_WATER_STATUS_KEYS, v.waterStatus)),
      toJsonParam(fillNulls(NOTE_PAYER_AUTHORITY_KEYS, v.payerAuthority)),
      toJsonParam(fillNulls(NOTE_PRIOR_WORK_KEYS, v.priorWork)),
      v.locationOnProperty ?? null,
      v.symptomVerbatim ?? null,
      v.priorAttemptsDetail ?? null,
      v.accessNotes ?? null,
      toJsonParam(v.hazards),
      toJsonParam(v.urgencyContext),
      toJsonParam(fillNulls(NOTE_COMMITMENTS_MADE_KEYS, v.commitmentsMade)),
      v.occupancy,
      toJsonParam(v.notEstablished),
      v.dispatchSummary ?? null,
    ],
  );
  return parseOrThrow(TABLE, technicianNoteRowSchema, rows[0]);
}

/**
 * One page of calls eligible for note generation, keyset-paged on `call_id`
 * (`structured_knowledge.call_id` is the primary key, so it is a stable unique cursor).
 *
 * Eligibility is deliberately narrow: a call has a stored `structured_knowledge` row and is not a
 * superseded duplicate leg. Two things this query does NOT do, both on purpose:
 *
 * - It does NOT join `clean_transcripts`. Readability is checked per call by the generator so an
 *   absent / soft-deleted / hard-deleted transcript becomes a COUNTED SKIP. Filtering it here
 *   would make those calls silently invisible, and the dry-run counters exist precisely to
 *   surface them.
 * - It does NOT look at `call_state.status`. A stored knowledge row already implies the call
 *   reached the end of the pipeline.
 *
 * It DOES exclude calls `extract` already judged non-dispatchable — intent on
 * {@link NOTE_NON_DISPATCH_INTENTS} AND no plumbing topic (`service_category = 'other'`). A
 * technician is never sent to a general enquiry or a billing question, so a note for one costs a
 * model call to produce an empty gap list that then sits on the review surface looking like a
 * failure. The exclusion lives HERE rather than in the generator on purpose: the generator's input
 * is `getCleanTranscript` and nothing else (ADR 0009), and this query already reads
 * `structured_knowledge`, so no new dependency is introduced and no model call is ever reserved
 * for a call that will not be noted. {@link countNonDispatchableCandidates} reports how many the
 * rule removes.
 *
 * `superseded_by_call_id IS NULL` matches every other knowledge reader (see `buildWhere` in
 * structured-knowledge-repo): one conversation can arrive as several Dialpad legs, and generating
 * a note per leg would hand a technician the same job twice.
 *
 * `regenerate` false (the default re-run) skips calls that already have a note at
 * `promptVersion`, which is what makes the job cheaply re-runnable. `regenerate` true returns
 * them anyway so a new prompt version can be rolled over an existing corpus.
 */
export async function listNoteCandidateCallIds(
  db: Queryable,
  opts: { promptVersion: string; regenerate: boolean; limit: number; cursor?: string },
): Promise<string[]> {
  const rows = await query<{ call_id: string }>(
    db,
    `SELECT sk.call_id
       FROM structured_knowledge sk
       LEFT JOIN technician_notes tn ON tn.call_id = sk.call_id
      WHERE sk.superseded_by_call_id IS NULL
        -- ::text casts because both columns are Postgres ENUMs; comparing one to a text[]
        -- parameter without the cast fails with "operator does not exist: call_intent = text".
        AND NOT (sk.call_intent::text = ANY($5::text[]) AND sk.service_category::text = 'other')
        AND ($1 OR tn.call_id IS NULL OR tn.prompt_version <> $2)
        AND ($3::text IS NULL OR sk.call_id > $3::text)
      ORDER BY sk.call_id
      LIMIT $4`,
    [
      opts.regenerate,
      opts.promptVersion,
      opts.cursor ?? null,
      opts.limit,
      [...NOTE_NON_DISPATCH_INTENTS],
    ],
  );
  return rows.map((r) => r.call_id);
}

/**
 * How many candidates the non-dispatchable rule removes, for the run summary.
 *
 * CORPUS-WIDE, not bounded by `--limit`: it answers "how many calls will this rule never note",
 * which is what a dry-run preview needs before committing to a full pass. It counts only calls
 * that would OTHERWISE have been candidates, so it shrinks as notes are written, exactly as
 * `listNoteCandidateCallIds` does.
 *
 * Excluded calls get no `processing_log` row — they were never attempted, and one row per excluded
 * call per run would be pure noise. This count is the record.
 */
export async function countNonDispatchableCandidates(
  db: Queryable,
  opts: { promptVersion: string; regenerate: boolean },
): Promise<number> {
  const rows = await query<{ n: string }>(
    db,
    `SELECT count(*)::text AS n
       FROM structured_knowledge sk
       LEFT JOIN technician_notes tn ON tn.call_id = sk.call_id
      WHERE sk.superseded_by_call_id IS NULL
        AND sk.call_intent::text = ANY($3::text[])
        AND sk.service_category::text = 'other'
        AND ($1 OR tn.call_id IS NULL OR tn.prompt_version <> $2)`,
    [opts.regenerate, opts.promptVersion, [...NOTE_NON_DISPATCH_INTENTS]],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getTechnicianNote(
  db: Queryable,
  callId: string,
): Promise<TechnicianNoteRow | undefined> {
  const rows = await query<TechnicianNoteRow>(
    db,
    `SELECT * FROM technician_notes WHERE call_id = $1`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, technicianNoteRowSchema, rows[0]) : undefined;
}

// --- Note-review surface read model (ADR 0009) ---
//
// Read-only, parameterized queries for the authenticated note-review surface (`src/notes/`). An
// EXPLICIT column allowlist, never a wildcard select — `getTechnicianNote` above keeps its
// `SELECT *` because it is the GENERATOR's read (it round-trips the full row it just wrote); this
// section is the SURFACE's, and `test/notes/module-graph.test.ts` asserts no `SELECT *` and no
// raw/vault table name appears below this marker.
//
// Both readers join `structured_knowledge` for the call's category/urgency/date. All filters go
// through the single {@link buildNoteWhere} so a page and its total can never disagree about which
// notes matched.

/** The allowlisted note columns the surface reads (order = the detail DTO's field order). */
const NOTE_READ_COLS =
  'tn.call_id, tn.prompt_version, tn.scope_signal, tn.equipment, tn.system_context, ' +
  'tn.water_status, tn.payer_authority, tn.prior_work, tn.location_on_property, ' +
  'tn.symptom_verbatim, tn.prior_attempts_detail, tn.access_notes, tn.hazards, ' +
  'tn.urgency_context, tn.commitments_made, tn.occupancy, tn.not_established, tn.dispatch_summary';

/**
 * Which verdicts a note has drawn, as the list filter expresses it:
 *  - `unreviewed`    — no verdict at all at the note's CURRENT prompt version
 *  - `has_verdicts`  — at least one
 *  - `has_wrong`     — at least one STANDING verdict that is not `correct`
 */
export type NoteReviewState = 'unreviewed' | 'has_verdicts' | 'has_wrong';

/** The repo's parameterized filter contract. Date bounds are pre-resolved UTC instants (the
 * date-only parsing rules live in `src/notes/query.ts`). */
export interface NoteQueryFilters {
  serviceCategory?: string;
  urgency?: string;
  reviewState?: NoteReviewState;
  fromInclusive?: Date;
  toExclusive?: Date;
}

/** One note as the LIST renders it. `created_at` is the CALL's date (`structured_knowledge`), not
 * the note's: a reviewer moving between /knowledge and /notes must see one date per call, and
 * `technician_notes.created_at` is a batch-scheduling artifact. */
export interface NoteListReadRow {
  call_id: string;
  created_at: Date;
  service_category: string;
  urgency: string;
  dispatch_summary: string | null;
  not_established: string[];
  review_state: NoteReviewState;
}

/** One note as the DETAIL renders it: every note column plus the joined call facts. */
export interface NoteDetailReadRow {
  call_id: string;
  prompt_version: string;
  created_at: Date;
  service_category: string;
  urgency: string;
  scope_signal: string;
  equipment: Record<string, string | null>;
  system_context: Record<string, string | null>;
  water_status: Record<string, boolean | null>;
  payer_authority: Record<string, boolean | null>;
  prior_work: Record<string, boolean | null>;
  location_on_property: string | null;
  symptom_verbatim: string | null;
  prior_attempts_detail: string | null;
  access_notes: string | null;
  hazards: string[];
  urgency_context: string[];
  commitments_made: Record<string, boolean | null>;
  occupancy: string;
  not_established: string[];
  dispatch_summary: string | null;
}

/**
 * The review-state EXISTS clauses, scoped to the note's OWN `prompt_version`.
 *
 * Version scoping is the point: a note regenerated under a new prompt version reads as unreviewed
 * again, because a verdict given against v1 says nothing about the v2 note that replaced it. The
 * `has_wrong` variant resolves the STANDING verdict per (field_path, reviewer_actor) first — a
 * reviewer who marked a field wrong and then corrected themselves to `correct` must not keep the
 * note in the "has wrong" bucket forever.
 */
const HAS_ANY_VERDICT = `EXISTS (
  SELECT 1 FROM note_feedback nf
   WHERE nf.call_id = tn.call_id AND nf.note_prompt_version = tn.prompt_version)`;

const HAS_WRONG_VERDICT = `EXISTS (
  SELECT 1 FROM (
    SELECT DISTINCT ON (nf.field_path, nf.reviewer_actor) nf.verdict
      FROM note_feedback nf
     WHERE nf.call_id = tn.call_id AND nf.note_prompt_version = tn.prompt_version
     ORDER BY nf.field_path, nf.reviewer_actor, nf.created_at DESC, nf.id DESC
  ) standing
   WHERE standing.verdict <> 'correct')`;

/** Build the shared WHERE clause + ordered params. `$1..$n` positional; no value interpolation. */
function buildNoteWhere(filters: NoteQueryFilters): { clause: string; params: unknown[] } {
  // Superseded (duplicate-leg) rows are hidden, matching every other knowledge reader: one
  // conversation can arrive as several Dialpad legs, and showing a note per leg would ask the
  // reviewer to judge the same job twice.
  const clauses: string[] = ['sk.superseded_by_call_id IS NULL'];
  const params: unknown[] = [];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    clauses.push(sql(params.length));
  };

  if (filters.serviceCategory !== undefined)
    add((n) => `sk.service_category = $${n}`, filters.serviceCategory);
  if (filters.urgency !== undefined) add((n) => `sk.urgency = $${n}`, filters.urgency);
  if (filters.fromInclusive !== undefined)
    add((n) => `sk.created_at >= $${n}`, filters.fromInclusive);
  if (filters.toExclusive !== undefined) add((n) => `sk.created_at < $${n}`, filters.toExclusive);

  if (filters.reviewState === 'unreviewed') clauses.push(`NOT ${HAS_ANY_VERDICT}`);
  else if (filters.reviewState === 'has_verdicts') clauses.push(HAS_ANY_VERDICT);
  else if (filters.reviewState === 'has_wrong') clauses.push(HAS_WRONG_VERDICT);

  return { clause: `WHERE ${clauses.join(' AND ')}`, params };
}

/** One page of matching notes, deterministically ordered (newest call first). */
export async function searchTechnicianNotes(
  db: Queryable,
  filters: NoteQueryFilters,
  page: { limit: number; offset: number },
): Promise<NoteListReadRow[]> {
  const { clause, params } = buildNoteWhere(filters);
  const limitPos = params.length + 1;
  const offsetPos = params.length + 2;
  return query<NoteListReadRow>(
    db,
    `SELECT tn.call_id, sk.created_at, sk.service_category, sk.urgency,
            tn.dispatch_summary, tn.not_established,
            CASE WHEN ${HAS_WRONG_VERDICT} THEN 'has_wrong'
                 WHEN ${HAS_ANY_VERDICT} THEN 'has_verdicts'
                 ELSE 'unreviewed' END AS review_state
       FROM technician_notes tn
       JOIN structured_knowledge sk ON sk.call_id = tn.call_id
       ${clause}
      ORDER BY sk.created_at DESC, tn.call_id DESC
      LIMIT $${limitPos} OFFSET $${offsetPos}`,
    [...params, page.limit, page.offset],
  );
}

/** How many notes match the filters — same WHERE as {@link searchTechnicianNotes}. */
export async function countTechnicianNotes(
  db: Queryable,
  filters: NoteQueryFilters,
): Promise<number> {
  const { clause, params } = buildNoteWhere(filters);
  const rows = await query<{ count: string }>(
    db,
    `SELECT count(*)::text AS count
       FROM technician_notes tn
       JOIN structured_knowledge sk ON sk.call_id = tn.call_id
       ${clause}`,
    params,
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * One note for the detail view, or `undefined`. Joined to `structured_knowledge` on the same
 * `superseded_by_call_id IS NULL` terms as the list, so a call reachable from the list is
 * reachable here and a superseded leg is reachable from neither.
 */
export async function getTechnicianNoteDetail(
  db: Queryable,
  callId: string,
): Promise<NoteDetailReadRow | undefined> {
  const rows = await query<NoteDetailReadRow>(
    db,
    `SELECT ${NOTE_READ_COLS}, sk.created_at, sk.service_category, sk.urgency
       FROM technician_notes tn
       JOIN structured_knowledge sk ON sk.call_id = tn.call_id
      WHERE tn.call_id = $1 AND sk.superseded_by_call_id IS NULL`,
    [callId],
  );
  return rows[0];
}
