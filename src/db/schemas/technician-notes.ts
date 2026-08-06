import { z } from 'zod';
import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
  noteOccupancySchema,
  noteScopeSignalSchema,
} from '../enums.js';

/**
 * technician_notes — the durable job-readiness note a technician reads before a visit. PK: call_id,
 * one current note per call (regenerated in place).
 *
 * NOT PURGED (ADR 0009): de-identified derived knowledge in the same class as
 * `structured_knowledge`. The row carries the retention triplet so a policy change stays a
 * registration rather than a migration, but no retention group touches it.
 *
 * Every column is structurally incapable of holding free text the model could smuggle PII into,
 * except the four narrative fields (`location_on_property`, `symptom_verbatim`,
 * `prior_attempts_detail`, `access_notes`) and `dispatch_summary`, which are written from the
 * REDACTED transcript and pass the same residual scan as every other model output.
 */

/**
 * Build a `.strict()` object of nullable members over a fixed key tuple. `.strict()` is what stops
 * an extra key — a stray free-text field — riding into a jsonb column.
 *
 * Members are plain `.nullable()`, never `.default(null)`: a default would make zod's input and
 * output types diverge, which `parseOrThrow`'s `z.ZodType<T>` cannot express. Completeness is
 * guaranteed on the WRITE side instead — {@link fillNulls} and the column defaults both store
 * every key — so a stored object always parses.
 */
function nullableObject<K extends readonly [string, ...string[]], V extends z.ZodTypeAny>(
  keys: K,
  value: V,
): z.ZodObject<Record<K[number], z.ZodNullable<V>>, 'strict'> {
  const shape = Object.fromEntries(keys.map((k) => [k, value.nullable()])) as Record<
    K[number],
    z.ZodNullable<V>
  >;
  return z.object(shape).strict();
}

/**
 * Expand a caller's partial object into a COMPLETE one, every absent or `undefined` member set to
 * null. Built key-by-key from the tuple rather than by spreading, so an explicit
 * `{ brand: undefined }` cannot punch a hole that `JSON.stringify` would then drop.
 */
export function fillNulls<K extends readonly [string, ...string[]], T>(
  keys: K,
  partial: Partial<Record<K[number], T | null>> | undefined,
): Record<K[number], T | null> {
  return Object.fromEntries(keys.map((k) => [k, partial?.[k as K[number]] ?? null])) as Record<
    K[number],
    T | null
  >;
}

const str = z.string();
const bool = z.boolean();

/** What kind of unit, whose, which model, how big, how old, what fuel. */
export const noteEquipmentSchema = nullableObject(NOTE_EQUIPMENT_KEYS, str);
/** Septic vs sewer, well vs city, slab vs crawlspace, age of the property. */
export const noteSystemContextSchema = nullableObject(NOTE_SYSTEM_CONTEXT_KEYS, str);
/** The emergency triage signal — booleans only, never a location or an amount. */
export const noteWaterStatusSchema = nullableObject(NOTE_WATER_STATUS_KEYS, bool);
/** Can this person authorize the work, and who is paying. */
export const notePayerAuthoritySchema = nullableObject(NOTE_PAYER_AUTHORITY_KEYS, bool);
/** Have we been out before, is it under warranty, did someone else work on it. */
export const notePriorWorkSchema = nullableObject(NOTE_PRIOR_WORK_KEYS, bool);
/**
 * WHETHER a price / dispatch fee / arrival window / technician / scope was communicated on the
 * call — never the amount, the time, or the name. A technician must not contradict what was
 * promised, and knowing a promise exists is enough to make them check first.
 */
export const noteCommitmentsMadeSchema = nullableObject(NOTE_COMMITMENTS_MADE_KEYS, bool);

export type NoteEquipment = z.infer<typeof noteEquipmentSchema>;
export type NoteSystemContext = z.infer<typeof noteSystemContextSchema>;
export type NoteWaterStatus = z.infer<typeof noteWaterStatusSchema>;
export type NotePayerAuthority = z.infer<typeof notePayerAuthoritySchema>;
export type NotePriorWork = z.infer<typeof notePriorWorkSchema>;
export type NoteCommitmentsMade = z.infer<typeof noteCommitmentsMadeSchema>;

/** The cap the DB CHECK enforces; a dispatch summary is read on a phone in a driveway. */
export const DISPATCH_SUMMARY_MAX_LENGTH = 800;

export const technicianNoteRowSchema = z.object({
  call_id: z.string(),
  prompt_version: z.string(),
  model_id: z.string(),
  schema_version: z.number().int(),
  scope_signal: noteScopeSignalSchema,
  equipment: noteEquipmentSchema,
  system_context: noteSystemContextSchema,
  water_status: noteWaterStatusSchema,
  payer_authority: notePayerAuthoritySchema,
  prior_work: notePriorWorkSchema,
  location_on_property: z.string().nullable(),
  symptom_verbatim: z.string().nullable(),
  prior_attempts_detail: z.string().nullable(),
  access_notes: z.string().nullable(),
  hazards: z.array(z.string()),
  urgency_context: z.array(z.string()),
  commitments_made: noteCommitmentsMadeSchema,
  occupancy: noteOccupancySchema,
  not_established: z.array(z.string()),
  dispatch_summary: z.string().nullable(),
  created_at: z.date(),
  // Present but never set by any retention group (ADR 0009).
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type TechnicianNoteRow = z.infer<typeof technicianNoteRowSchema>;

export const technicianNoteInsertSchema = z.object({
  callId: z.string().min(1),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  scopeSignal: noteScopeSignalSchema,
  // Partial on the way in — a caller supplies only what the call established. The repo expands
  // each to a complete key set (see `fillNulls`), so what is STORED is always whole.
  equipment: noteEquipmentSchema.partial().optional(),
  systemContext: noteSystemContextSchema.partial().optional(),
  waterStatus: noteWaterStatusSchema.partial().optional(),
  payerAuthority: notePayerAuthoritySchema.partial().optional(),
  priorWork: notePriorWorkSchema.partial().optional(),
  locationOnProperty: z.string().nullable().optional(),
  symptomVerbatim: z.string().nullable().optional(),
  priorAttemptsDetail: z.string().nullable().optional(),
  accessNotes: z.string().nullable().optional(),
  hazards: z.array(z.string()).optional(),
  urgencyContext: z.array(z.string()).optional(),
  commitmentsMade: noteCommitmentsMadeSchema.partial().optional(),
  occupancy: noteOccupancySchema,
  notEstablished: z.array(z.string()).optional(),
  // Mirrors the DB CHECK so an over-long summary fails before it reaches SQL.
  dispatchSummary: z.string().max(DISPATCH_SUMMARY_MAX_LENGTH).nullable().optional(),
});
export type TechnicianNoteInsert = z.infer<typeof technicianNoteInsertSchema>;
