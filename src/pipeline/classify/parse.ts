import { z } from 'zod';
import { CLASSIFY_BUCKETS } from '../../anthropic/client.js';

/**
 * Classify response parser — a PURE module. No DB, no logger, no network.
 *
 * It turns a raw model result (`{text, stopReason}`) into either a validated
 * bucket or an exact failure kind. It never logs and never returns the model's
 * free-text `reason` (see the DISCARD note below).
 */

// SINGLE SOURCE OF TRUTH — do NOT redefine the bucket tuple here.
export type ClassifyBucket = (typeof CLASSIFY_BUCKETS)[number];

/**
 * The validation mirror of the wire schema (`CLASSIFY_OUTPUT_FORMAT` in
 * anthropic/client.ts). `z.enum` needs a readonly string tuple; CLASSIFY_BUCKETS
 * is `as const`. A cross-check test asserts this enum equals the wire enum.
 */
export const classificationSchema = z
  .object({
    bucket: z.enum(CLASSIFY_BUCKETS),
    reason: z.string().min(1).max(300), // validated for shape, then DISCARDED (see below)
  })
  .strict();

export type ParseFailureKind =
  'empty' | 'truncated' | 'refusal' | 'unexpected_stop_reason' | 'non_json' | 'schema_invalid';

/** The only stop reasons a well-formed classify completion may carry. */
const NORMAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

export function parseClassification(result: {
  text: string | null;
  stopReason: string | null;
}): { ok: true; bucket: ClassifyBucket } | { ok: false; failure: ParseFailureKind } {
  const { text, stopReason } = result;

  // Precedence is deliberate — stop-reason checks run FIRST so a truncated or
  // refused completion is never mistaken for a (possibly schema-valid) answer.
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

  const validated = classificationSchema.safeParse(parsed);
  if (!validated.success) return { ok: false, failure: 'schema_invalid' };

  // DISCARD `reason` on purpose: it is untrusted model free-text that could carry
  // PII the Task 4.1 scan would catch, but that machinery isn't wired here yet.
  // Returning ONLY the bucket makes it structurally impossible to persist or log.
  return { ok: true, bucket: validated.data.bucket };
}
