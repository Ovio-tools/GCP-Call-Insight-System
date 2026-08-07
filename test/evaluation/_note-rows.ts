import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
  type NoteFeedbackVerdict,
  type NoteFieldPath,
} from '../../src/db/enums.js';
import { fillNulls, type TechnicianNoteRow } from '../../src/db/schemas/technician-notes.js';
import type { NoteFeedbackRow } from '../../src/db/schemas/note-feedback.js';

/**
 * In-memory row builders for the note-evaluation suites. Everything the note report and the note
 * fixture export consume is a STORED ROW, so the whole feature is testable without a database and
 * without a model call — which is exactly the property the fixture reproducibility test pins.
 */

/** A fixed instant, so nothing in these suites depends on the wall clock. */
export const T0 = new Date('2026-03-01T09:00:00.000Z');

/** `T0` plus n minutes — for ordering an append-only sequence of verdicts. */
export function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

let seq = 0;
/** Monotonic uuid-shaped id, so `(created_at, id)` tie-breaks are deterministic across runs. */
export function nextId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export interface FeedbackOverrides {
  callId?: string;
  promptVersion?: string;
  reviewer?: string;
  correctedEnumValue?: string | null;
  createdAt?: Date;
  id?: string;
}

/** One `note_feedback` row. Defaults are the common case: one call, one reviewer, one version. */
export function feedbackRow(
  fieldPath: NoteFieldPath,
  verdict: NoteFeedbackVerdict,
  overrides: FeedbackOverrides = {},
): NoteFeedbackRow {
  return {
    id: overrides.id ?? nextId(),
    call_id: overrides.callId ?? 'call-1',
    note_prompt_version: overrides.promptVersion ?? 'tech-note-v1',
    reviewer_actor: overrides.reviewer ?? 'reviewer-a',
    field_path: fieldPath,
    verdict,
    corrected_enum_value: overrides.correctedEnumValue ?? null,
    created_at: overrides.createdAt ?? at(0),
  };
}

export interface NoteOverrides {
  callId?: string;
  promptVersion?: string;
  notEstablished?: string[];
  scopeSignal?: TechnicianNoteRow['scope_signal'];
  occupancy?: TechnicianNoteRow['occupancy'];
  equipment?: Partial<TechnicianNoteRow['equipment']>;
  waterStatus?: Partial<TechnicianNoteRow['water_status']>;
  symptomVerbatim?: string | null;
  accessNotes?: string | null;
  hazards?: string[];
  dispatchSummary?: string | null;
}

/** One `technician_notes` row, every jsonb group complete (as the repo always stores it). */
export function noteRow(overrides: NoteOverrides = {}): TechnicianNoteRow {
  return {
    call_id: overrides.callId ?? 'call-1',
    prompt_version: overrides.promptVersion ?? 'tech-note-v1',
    model_id: 'claude-sonnet-4-6',
    schema_version: 1,
    scope_signal: overrides.scopeSignal ?? 'single_fixture',
    equipment: fillNulls<typeof NOTE_EQUIPMENT_KEYS, string>(NOTE_EQUIPMENT_KEYS, {
      type: 'tank water heater',
      ...overrides.equipment,
    }),
    system_context: fillNulls<typeof NOTE_SYSTEM_CONTEXT_KEYS, string>(NOTE_SYSTEM_CONTEXT_KEYS, {
      water_source: 'city',
    }),
    water_status: fillNulls<typeof NOTE_WATER_STATUS_KEYS, boolean>(NOTE_WATER_STATUS_KEYS, {
      actively_running: false,
      ...overrides.waterStatus,
    }),
    payer_authority: fillNulls<typeof NOTE_PAYER_AUTHORITY_KEYS, boolean>(
      NOTE_PAYER_AUTHORITY_KEYS,
      { can_approve_work: true },
    ),
    prior_work: fillNulls<typeof NOTE_PRIOR_WORK_KEYS, boolean>(NOTE_PRIOR_WORK_KEYS, {
      is_repeat_visit: false,
    }),
    location_on_property: 'garage',
    symptom_verbatim: overrides.symptomVerbatim ?? 'water pooling under the tank',
    prior_attempts_detail: null,
    access_notes: overrides.accessNotes ?? 'side gate is unlocked during the day',
    hazards: overrides.hazards ?? [],
    urgency_context: [],
    commitments_made: fillNulls<typeof NOTE_COMMITMENTS_MADE_KEYS, boolean>(
      NOTE_COMMITMENTS_MADE_KEYS,
      { dispatch_fee_mentioned: true },
    ),
    occupancy: overrides.occupancy ?? 'owner',
    not_established: overrides.notEstablished ?? [],
    dispatch_summary: overrides.dispatchSummary ?? 'Leaking tank water heater in the garage.',
    created_at: at(0),
    retention_eligible_at: null,
    soft_deleted_at: null,
    hard_deleted_at: null,
  };
}
