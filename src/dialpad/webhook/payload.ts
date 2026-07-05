import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '../../db/types.js';
import type { DialpadJwtResult } from './jwt.js';

/**
 * Minimization + allowlisting for a decoded Dialpad webhook event (Task 3.2).
 *
 * The claim field names are PROVISIONAL — mirrored from the Task 3.1 metadata pre-filter and
 * confirmed against real staging payloads. This lenient `passthrough` schema is the single place
 * to adjust them. Nothing here copies the raw payload: the audit row and `call_state` are built
 * up from an explicit allowlist, so transcript/message/free-text can never leak even if Dialpad
 * adds fields. Any phone/name found ANYWHERE is one-way hashed, never stored in clear.
 */
// Each field is independently tolerant: a present-but-wrong-typed value is dropped to `undefined`
// (via `.catch`) instead of failing the whole parse. A bad mapping can only under-populate
// metadata — one malformed field never rejects an otherwise usable event.
const idField = z.union([z.string(), z.number()]).optional().catch(undefined);
export const dialpadClaimsSchema = z
  .object({
    call_id: idField,
    event_id: idField,
    id: idField,
    jti: z.string().optional().catch(undefined),
    direction: z.string().optional().catch(undefined),
    state: z.string().optional().catch(undefined),
    duration: z.number().optional().catch(undefined),
    is_internal: z.boolean().optional().catch(undefined),
    operator_call_id: idField,
    master_call_id: idField,
    iat: z.number().optional().catch(undefined),
    date_started: z.number().optional().catch(undefined),
    date_ended: z.number().optional().catch(undefined),
  })
  .passthrough();

export type DialpadClaims = z.infer<typeof dialpadClaimsSchema>;

/** Parse raw claims leniently; unknown fields are preserved for the PII scan but never stored. */
export function parseClaims(claims: Record<string, unknown>): DialpadClaims {
  const parsed = dialpadClaimsSchema.safeParse(claims);
  return parsed.success ? parsed.data : {};
}

/** The call's id as a string (Dialpad ids may arrive as numbers). Undefined if absent/empty. */
export function extractCallId(claims: DialpadClaims): string | undefined {
  const raw = claims.call_id;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Replay key, per the fallback matrix (the middleware already namespaces it by provider):
 *   (a) a unique event id claim (jti / event_id / id) → `id:<value>`
 *   (b) else, using the signed `iat` timestamp → `sig:<sha256(payload)>:<iat>`
 *   (c) else, digest of the signed payload alone → `sig:<sha256(payload)>` (documented limitation:
 *       two byte-identical distinct events collapse to one — the fail-safe direction).
 * The payload segment is the exact signed bytes, so the digest is canonical and unforgeable.
 */
export function replayKeyFor(result: DialpadJwtResult): string {
  const claims = parseClaims(result.claims);
  for (const candidate of [claims.jti, claims.event_id, claims.id]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim().length > 0) {
      return `id:${String(candidate).trim()}`;
    }
  }
  const digest = createHash('sha256').update(result.payloadSegment).digest('hex');
  return typeof claims.iat === 'number' ? `sig:${digest}:${claims.iat}` : `sig:${digest}`;
}

/** Field-name sets (lowercased) that may carry PII. Values found under these keys are hashed. */
const PHONE_FIELDS = new Set([
  'phone',
  'phone_number',
  'external_number',
  'internal_number',
  'from_number',
  'to_number',
  'caller_number',
  'callee_number',
  'contact_phone',
  'number',
]);
const NAME_FIELDS = new Set([
  'name',
  'contact_name',
  'display_name',
  'first_name',
  'last_name',
  'customer_name',
]);

/** Collect every primitive string/number leaf under a node (through arrays and nested objects). */
function collectLeaves(node: unknown, out: Set<string>): void {
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    if (s.length > 0) out.add(s);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectLeaves(item, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node)) collectLeaves(v, out);
  }
}

/**
 * Recursively collect any phone/name values found ANYWHERE in the payload (deduped). A value under
 * a PII-labeled key is collected whether it is a scalar, an array (`phone: ["+1555..."]`), or a
 * nested object — every primitive leaf under that key is hashed, so no raw phone/name survives.
 */
export function collectPii(value: unknown): { phones: string[]; names: string[] } {
  const phones = new Set<string>();
  const names = new Set<string>();

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (PHONE_FIELDS.has(lower)) {
        collectLeaves(v, phones);
      } else if (NAME_FIELDS.has(lower)) {
        collectLeaves(v, names);
      } else {
        walk(v); // keep scanning deeper for PII-labeled keys
      }
    }
  };

  walk(value);
  return { phones: [...phones], names: [...names] };
}

/** Copy only the keys whose value is defined, coercing ids to strings. */
function nonPiiMetadata(claims: DialpadClaims): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (claims.direction !== undefined) out.direction = claims.direction;
  if (claims.state !== undefined) out.state = claims.state;
  if (claims.duration !== undefined) out.duration = claims.duration;
  if (claims.is_internal !== undefined) out.is_internal = claims.is_internal;
  if (claims.operator_call_id !== undefined) out.operator_call_id = String(claims.operator_call_id);
  if (claims.master_call_id !== undefined) out.master_call_id = String(claims.master_call_id);
  if (claims.date_started !== undefined) out.date_started = claims.date_started;
  if (claims.date_ended !== undefined) out.date_ended = claims.date_ended;
  return out;
}

/**
 * Metadata for `call_state.source_metadata` — the Task 3.1 pre-filter's input. `call_state` is
 * retained indefinitely, so this is a STRICT non-PII allowlist: no phone/name, not even hashed.
 */
export function toCallStateMetadata(claims: Record<string, unknown>): Record<string, JsonValue> {
  return nonPiiMetadata(parseClaims(claims));
}

/**
 * Payload for the (short-lived, purgeable) `raw_webhook_events` audit row: the non-PII allowlist
 * plus the replay/event id, the call id, `iat`, and — when a phone or name appears anywhere —
 * `phone_hmac` / `name_hmac` arrays. Never the raw payload, never transcript/free-text.
 */
export function toAuditPayload(
  result: DialpadJwtResult,
  hashOne: (value: string) => string,
): Record<string, JsonValue> {
  const claims = parseClaims(result.claims);
  const payload: Record<string, JsonValue> = {
    event_id: replayKeyFor(result),
    ...nonPiiMetadata(claims),
  };
  const callId = extractCallId(claims);
  if (callId !== undefined) payload.call_id = callId;
  if (typeof claims.iat === 'number') payload.iat = claims.iat;

  const { phones, names } = collectPii(result.claims);
  if (phones.length > 0) payload.phone_hmac = phones.map(hashOne);
  if (names.length > 0) payload.name_hmac = names.map(hashOne);

  return payload;
}
