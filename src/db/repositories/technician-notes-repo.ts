import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
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
        AND ($1 OR tn.call_id IS NULL OR tn.prompt_version <> $2)
        AND ($3::text IS NULL OR sk.call_id > $3::text)
      ORDER BY sk.call_id
      LIMIT $4`,
    [opts.regenerate, opts.promptVersion, opts.cursor ?? null, opts.limit],
  );
  return rows.map((r) => r.call_id);
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
