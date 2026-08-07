import { z } from 'zod';
import {
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_UNSET_TEXT,
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

/** A `.strict()` object over a fixed key tuple, every member the same schema. */
function noteGroup<K extends readonly [string, ...string[]], V extends z.ZodTypeAny>(
  keys: K,
  value: V,
): z.ZodObject<Record<K[number], V>, 'strict'> {
  const shape = Object.fromEntries(keys.map((k) => [k, value])) as Record<K[number], V>;
  return z.object(shape).strict();
}

/**
 * The wire → record boundary for "the call did not establish this" (ADR 0009).
 *
 * The model cannot answer `null`: the wire schema encodes unset as a VALUE, because structured
 * outputs cap a schema at 16 union-typed parameters and this note has 31 fields that can be
 * unset (see the comment on TECHNICIAN_NOTE_OUTPUT_FORMAT in `src/anthropic/client.ts`). These
 * two preprocessors are where that transport detail STOPS: everything downstream of this module
 * — the gap list, the residual scan, `technician_notes`, the review surface — sees the same
 * nulls it always saw, and no other module needs to know the sentinels exist.
 *
 * Anything that is not a sentinel is passed through untouched, so a literal `null` or a real
 * boolean still validates. That tolerance is deliberate: the wire schema is the enforcement
 * point, and a parser that rejected the older encoding would turn a schema regression into a
 * confusing `schema_invalid` retry loop instead of the 400 it actually is.
 */
function unsetTextToNull<V extends z.ZodTypeAny>(
  value: V,
): z.ZodEffects<z.ZodNullable<V>, z.output<V> | null, unknown> {
  return z.preprocess((raw) => (raw === NOTE_UNSET_TEXT ? null : raw), value.nullable());
}

const tristate = z.preprocess((raw) => {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  if (raw === 'unknown') return null;
  return raw;
}, z.boolean().nullable());

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
    equipment: noteGroup(NOTE_EQUIPMENT_KEYS, unsetTextToNull(shortText)),
    system_context: noteGroup(NOTE_SYSTEM_CONTEXT_KEYS, unsetTextToNull(shortText)),
    water_status: noteGroup(NOTE_WATER_STATUS_KEYS, tristate),
    payer_authority: noteGroup(NOTE_PAYER_AUTHORITY_KEYS, tristate),
    prior_work: noteGroup(NOTE_PRIOR_WORK_KEYS, tristate),
    commitments_made: noteGroup(NOTE_COMMITMENTS_MADE_KEYS, tristate),
    location_on_property: unsetTextToNull(mediumText),
    symptom_verbatim: unsetTextToNull(mediumText),
    prior_attempts_detail: unsetTextToNull(mediumText),
    access_notes: unsetTextToNull(mediumText),
    hazards: z.array(shortText).max(20),
    urgency_context: z.array(shortText).max(20),
    dispatch_summary: unsetTextToNull(z.string().min(1).max(DISPATCH_SUMMARY_MAX_LENGTH)),
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
