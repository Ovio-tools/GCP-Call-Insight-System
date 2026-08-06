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
} from '../db/enums.js';
import { DISPATCH_SUMMARY_MAX_LENGTH } from '../db/schemas/technician-notes.js';

/**
 * Technician-note response parser — a PURE module. No DB, no logger, no network.
 *
 * Mirrors src/pipeline/extract/parse.ts: it turns a raw model result (`{text, stopReason}`) into
 * either a validated note record or an exact failure kind. It never logs.
 */

/** A `.strict()` object over a fixed key tuple, every member nullable. */
function nullableGroup<K extends readonly [string, ...string[]], V extends z.ZodTypeAny>(
  keys: K,
  value: V,
): z.ZodObject<Record<K[number], z.ZodNullable<V>>, 'strict'> {
  const shape = Object.fromEntries(keys.map((k) => [k, value.nullable()])) as Record<
    K[number],
    z.ZodNullable<V>
  >;
  return z.object(shape).strict();
}

const shortText = z.string().min(1).max(300);
const mediumText = z.string().min(1).max(500);

/**
 * The validation mirror of the wire schema (`TECHNICIAN_NOTE_OUTPUT_FORMAT` in
 * anthropic/client.ts). `.strict()` at every level means any extra key — a smuggled `confidence`,
 * a `sentiment`, a `tone` — fails validation rather than being quietly dropped.
 *
 * `not_established` is deliberately ABSENT: it is computed in code by gates.ts from a fixed
 * REQUIRED_FOR_DISPATCH list. A model that volunteers one fails `.strict()`, which is the
 * intended outcome — the gap list must never be a model self-assessment.
 *
 * `dispatch_summary`'s length cap lives HERE rather than in the wire schema because structured
 * outputs reject length keywords. That placement is what makes an over-long summary a
 * `schema_invalid` failure (and therefore a bounded retry) instead of a silent truncation.
 */
export const technicianNoteRecordSchema = z
  .object({
    scope_signal: noteScopeSignalSchema,
    occupancy: noteOccupancySchema,
    equipment: nullableGroup(NOTE_EQUIPMENT_KEYS, shortText),
    system_context: nullableGroup(NOTE_SYSTEM_CONTEXT_KEYS, shortText),
    water_status: nullableGroup(NOTE_WATER_STATUS_KEYS, z.boolean()),
    payer_authority: nullableGroup(NOTE_PAYER_AUTHORITY_KEYS, z.boolean()),
    prior_work: nullableGroup(NOTE_PRIOR_WORK_KEYS, z.boolean()),
    commitments_made: nullableGroup(NOTE_COMMITMENTS_MADE_KEYS, z.boolean()),
    location_on_property: mediumText.nullable(),
    symptom_verbatim: mediumText.nullable(),
    prior_attempts_detail: mediumText.nullable(),
    access_notes: mediumText.nullable(),
    hazards: z.array(shortText).max(20),
    urgency_context: z.array(shortText).max(20),
    dispatch_summary: z.string().min(1).max(DISPATCH_SUMMARY_MAX_LENGTH).nullable(),
  })
  .strict();

export type TechnicianNoteRecord = z.infer<typeof technicianNoteRecordSchema>;

export type ParseFailureKind =
  'empty' | 'truncated' | 'refusal' | 'unexpected_stop_reason' | 'non_json' | 'schema_invalid';

/** The only stop reasons a well-formed note completion may carry. */
const NORMAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

export type ParseOutcome =
  | { ok: true; record: TechnicianNoteRecord }
  | {
      ok: false;
      failure: ParseFailureKind;
      /**
       * schema_invalid only: one line per zod issue, built from `path` + `code` ONLY — never
       * `message`, which can embed the received value. Fed back to the model on the ADR 0007
       * retry; NEVER logged, alerted, or persisted.
       */
      issueSummary?: string[];
    };

export function parseTechnicianNote(result: {
  text: string | null;
  stopReason: string | null;
}): ParseOutcome {
  const { text, stopReason } = result;

  // Precedence is deliberate (identical to extract) — stop-reason checks run FIRST so a truncated
  // or refused completion is never mistaken for a schema-valid answer.
  if (stopReason === 'refusal') return { ok: false, failure: 'refusal' };
  if (stopReason === 'max_tokens') return { ok: false, failure: 'truncated' };
  if (!NORMAL_STOP_REASONS.has(stopReason ?? '')) {
    // Catches null, 'tool_use', 'pause_turn', and any unknown future value.
    return { ok: false, failure: 'unexpected_stop_reason' };
  }

  if (text === null || text.trim() === '') return { ok: false, failure: 'empty' };

  let parsed: unknown;
  try {
    // Whole-string parse: fenced JSON, prose+JSON, two objects, and trailing prose all throw here
    // — no extra scanning or extraction is attempted.
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, failure: 'non_json' };
  }

  const validated = technicianNoteRecordSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      failure: 'schema_invalid',
      issueSummary: validated.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
    };
  }

  return { ok: true, record: validated.data };
}
