import { z } from 'zod';
import { CALL_INTENT, URGENCY, serviceCategorySchema, sentimentSchema } from '../../db/enums.js';

/**
 * Extract response parser — a PURE module. No DB, no logger, no network.
 *
 * Mirrors src/pipeline/classify/parse.ts: it turns a raw model result
 * (`{text, stopReason}`) into either a validated extraction record or an exact
 * failure kind. It never logs.
 */

/**
 * The validation mirror of the wire schema (`EXTRACT_OUTPUT_FORMAT` in
 * anthropic/client.ts). `.strict()` means any extra key (e.g. a smuggled
 * `confidence`) fails validation. A cross-check test asserts this schema's key
 * set and enums equal the wire schema.
 */
export const extractionRecordSchema = z
  .object({
    call_intent: z.enum(CALL_INTENT),
    service_category: serviceCategorySchema,
    problem_statement: z.string().min(1).max(500),
    symptoms: z.array(z.string().min(1).max(300)).max(20),
    customer_language: z.array(z.string().min(1).max(300)).max(20),
    competitor_mentions: z.array(z.string().min(1).max(300)).max(20),
    concerns: z.array(z.string().min(1).max(300)).max(20),
    location_in_home: z.string().min(1).max(500).nullable(),
    access_or_scheduling_notes: z.string().min(1).max(500).nullable(),
    prior_attempts: z.string().min(1).max(500).nullable(),
    acquisition_source: z.string().min(1).max(500).nullable(),
    urgency: z.enum(URGENCY),
    sentiment: sentimentSchema,
  })
  .strict();

export type ExtractionRecord = z.infer<typeof extractionRecordSchema>;

export type ParseFailureKind =
  'empty' | 'truncated' | 'refusal' | 'unexpected_stop_reason' | 'non_json' | 'schema_invalid';

/** The only stop reasons a well-formed extract completion may carry. */
const NORMAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

export type ParseOutcome =
  | { ok: true; record: ExtractionRecord }
  | {
      ok: false;
      failure: ParseFailureKind;
      /**
       * schema_invalid only: one line per zod issue, built from `path` + `code`
       * ONLY — never `message`, which can embed the received value. Fed back to
       * the model on the ADR 0007 retry; NEVER logged, alerted, or persisted.
       */
      issueSummary?: string[];
    };

export function parseExtraction(result: {
  text: string | null;
  stopReason: string | null;
}): ParseOutcome {
  const { text, stopReason } = result;

  // Precedence is deliberate (identical to classify) — stop-reason checks run FIRST
  // so a truncated or refused completion is never mistaken for a schema-valid answer.
  if (stopReason === 'refusal') return { ok: false, failure: 'refusal' };
  if (stopReason === 'max_tokens') return { ok: false, failure: 'truncated' };
  if (!NORMAL_STOP_REASONS.has(stopReason ?? '')) {
    // Catches null, 'tool_use', 'pause_turn', and any unknown future value.
    return { ok: false, failure: 'unexpected_stop_reason' };
  }

  if (text === null || text.trim() === '') return { ok: false, failure: 'empty' };

  let parsed: unknown;
  try {
    // Whole-string parse: fenced JSON, prose+JSON, two objects, and trailing
    // prose all throw here — no extra scanning or extraction is attempted.
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, failure: 'non_json' };
  }

  const validated = extractionRecordSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      failure: 'schema_invalid',
      issueSummary: validated.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.code}`,
      ),
    };
  }

  return { ok: true, record: validated.data };
}
