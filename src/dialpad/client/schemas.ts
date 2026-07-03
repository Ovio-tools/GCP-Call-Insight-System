import { z } from 'zod';

/**
 * Zod schemas for the two Dialpad responses this client consumes. They are deliberately
 * TOLERANT of unknown/extra fields (`.passthrough()`) but strict enough to (a) recognise a
 * transcript vs a not-yet-ready one, and (b) pull metadata-only fields for reconciliation.
 * A response that does not even match these loose shapes is treated as
 * `DIALPAD_API_CHANGED`, never an unhandled crash.
 *
 * NOTE: the exact field names are PROVISIONAL — Dialpad's full response schema is gated
 * behind a login on the public docs. This module is the single place to correct them; a
 * mismatch fails safe (unknown shape → api_changed; empty/pending → not_ready).
 */

/** One transcript line/moment. Only `content` is load-bearing (the spoken text). */
const transcriptLineSchema = z
  .object({
    content: z.string().optional(),
    type: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

/** GET /transcripts/{call_id}. Supports both a `lines[]` shape and a flat `transcript` string. */
export const transcriptResponseSchema = z
  .object({
    call_id: z.union([z.string(), z.number()]).optional(),
    /** Explicit processing markers Dialpad may set while the AI transcript is still cooking. */
    status: z.string().optional(),
    state: z.string().optional(),
    lines: z.array(transcriptLineSchema).optional(),
    transcript: z.string().optional(),
  })
  .passthrough();

export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

/** Status/state values that unambiguously mean "the transcript is not ready yet". */
const NOT_READY_MARKERS: ReadonlySet<string> = new Set([
  'pending',
  'processing',
  'in_progress',
  'queued',
  'not_ready',
]);

/** Readiness of a transcript response. `unrecognized` means the shape moved — api_changed. */
export type TranscriptReadiness = 'ready' | 'not_ready' | 'unrecognized';

/**
 * Classify a parsed transcript response. Only RECOGNISED shapes are accepted, so a genuine
 * Dialpad API shape change surfaces promptly as `unrecognized` (→ DIALPAD_API_CHANGED) instead
 * of masquerading as a transcript that is "not ready forever" and eventually held.
 *
 * - `ready`         — `lines[]` has real content, or a non-empty `transcript` string.
 * - `not_ready`     — an explicit processing marker (`status`/`state`), OR a recognised
 *                     empty-but-valid shape (`lines: []` / `transcript: ''`).
 * - `unrecognized`  — none of the known transcript/not-ready fields are present.
 */
export function classifyTranscript(parsed: TranscriptResponse): TranscriptReadiness {
  const marker = (parsed.status ?? parsed.state ?? '').toLowerCase();
  const hasMarker = parsed.status !== undefined || parsed.state !== undefined;
  const lines = parsed.lines;
  const flat = parsed.transcript;

  const readyByLines =
    Array.isArray(lines) &&
    lines.some((l) => typeof l.content === 'string' && l.content.trim().length > 0);
  const readyByFlat = typeof flat === 'string' && flat.trim().length > 0;
  if (readyByLines || readyByFlat) return 'ready';

  if (hasMarker && NOT_READY_MARKERS.has(marker)) return 'not_ready';
  // A recognised transcript container that is simply empty — a valid "still cooking" state.
  if (Array.isArray(lines) || typeof flat === 'string') return 'not_ready';

  return 'unrecognized';
}

/**
 * A recently-concluded call, metadata ONLY. No transcript, no message content, and no PII
 * (phone/name are never requested or surfaced) — this feeds the reconciliation sweep, which
 * only needs ids + coarse metadata to decide what to re-enqueue.
 */
export const recentCallSchema = z
  .object({
    call_id: z.union([z.string(), z.number()]),
    state: z.string().optional(),
    direction: z.string().optional(),
    duration: z.number().optional(),
    date_started: z.union([z.string(), z.number()]).optional(),
    date_ended: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/**
 * GET /calls — a paginated page of concluded calls, newest first, with a `cursor` to continue.
 * `items` is REQUIRED (an empty array is valid): if Dialpad renames/removes the collection
 * field, parsing fails → DIALPAD_API_CHANGED, so reconciliation never silently misses calls.
 */
export const recentCallsResponseSchema = z
  .object({
    items: z.array(recentCallSchema),
    cursor: z.string().optional(),
  })
  .passthrough();

export type RecentCallsResponse = z.infer<typeof recentCallsResponseSchema>;
