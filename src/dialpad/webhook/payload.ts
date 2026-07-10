import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '../../db/types.js';
import type { DialpadJwtResult } from './jwt.js';

/**
 * Minimization + allowlisting for a decoded Dialpad webhook event (Task 3.2).
 *
 * The claim field names are PROVISIONAL — mirrored from the Task 3.1 metadata pre-filter and not
 * yet reconciled against real production payloads (issue #31). Canonical fields (call id, metadata)
 * are therefore resolved from a small allowlist of known-equivalent shapes (see `resolveCallId` /
 * `nonPiiMetadata`) so a slightly different real spelling under-populates safely instead of hard-
 * rejecting the event. Nothing here copies the raw payload: the audit row and `call_state` are
 * built up from an explicit allowlist, so transcript/message/free-text can never leak even if
 * Dialpad adds fields. Any phone/name/email found ANYWHERE is normalized then one-way hashed,
 * never stored in clear.
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

// --- Canonical field resolution (MVP robustness, issue #31) -----------------------------------
// Real Dialpad payloads may vary slightly in field spelling and nesting from our provisional
// mirror of the Task 3.1 pre-filter fields. Rather than depend on a single exact spelling (which
// hard-rejects the whole event as REQUEST_MALFORMED), each canonical field is resolved from a
// small, EXPLICIT prioritized list of dotted paths — an allowlist of known-equivalent shapes, not
// a broad fuzzy search. An unknown shape still fails cleanly (undefined), never leaks a field.

/** Follow a dotted path through nested objects; returns the value or undefined (never throws). */
function atPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

type ScalarKind = 'string' | 'number' | 'boolean' | 'id';

/** First value across `paths` matching `kind` ('id' = string|number). Preserves fail-safe:
 *  a present-but-wrong-typed value is skipped, not accepted. */
function resolveScalar(
  root: unknown,
  paths: readonly string[],
  kind: ScalarKind,
): string | number | boolean | undefined {
  for (const path of paths) {
    const v = atPath(root, path);
    if (kind === 'id') {
      if (typeof v === 'string' || typeof v === 'number') return v;
    } else if (typeof v === kind) {
      return v as string | number | boolean;
    }
  }
  return undefined;
}

/** Known-equivalent paths for the call id. A bare top-level `id` is intentionally EXCLUDED — it
 *  is the event-id fallback (see `replayKeyFor`), not the call id, so it is only trusted when
 *  disambiguated by a `call`/`data` wrapper. */
const CALL_ID_PATHS = [
  'call_id',
  'callId',
  'call.call_id',
  'call.callId',
  'call.id',
  'data.call_id',
  'data.callId',
  'data.id',
] as const;

/** Resolve the call id from any known-equivalent shape. Undefined = clean reject (not a crash). */
export function resolveCallId(claims: Record<string, unknown>): string | undefined {
  const raw = resolveScalar(claims, CALL_ID_PATHS, 'id');
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

const DIRECTION_PATHS = ['direction', 'call.direction', 'data.direction'] as const;
const STATE_PATHS = ['state', 'call.state', 'data.state'] as const;
const DURATION_PATHS = ['duration', 'call.duration', 'data.duration'] as const;
const IS_INTERNAL_PATHS = [
  'is_internal',
  'internal',
  'call.is_internal',
  'call.internal',
  'data.is_internal',
  'data.internal',
] as const;
const OPERATOR_ID_PATHS = [
  'operator_call_id',
  'call.operator_call_id',
  'data.operator_call_id',
] as const;
const MASTER_ID_PATHS = ['master_call_id', 'call.master_call_id', 'data.master_call_id'] as const;
const DATE_STARTED_PATHS = ['date_started', 'call.date_started', 'data.date_started'] as const;
const DATE_ENDED_PATHS = ['date_ended', 'call.date_ended', 'data.date_ended'] as const;

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

// --- Payload shape diagnostic (issue #31) -----------------------------------------------------
// The claim field names are still PROVISIONAL. To reconcile them against what Dialpad REALLY
// sends, we need to see the structure of a live payload — but never its values (there is PII in
// there). `describePayloadShape` walks the decoded claims and returns ONLY the key paths and each
// leaf's TYPE (e.g. `call.id:number`, `contact.name:string`), never a value. The result is an
// array of strings so the logging redaction guard (which throws on an object KEY named `name` /
// `phone` / `transcript`) cannot trip on it: the payload's key names appear only inside string
// leaves, never as object keys. Off by default; enabled deliberately in staging via
// DIALPAD_WEBHOOK_LOG_PAYLOAD_SHAPE while capturing real deliveries.

/**
 * Structural fingerprint of a decoded payload: a sorted, deduped list of `path:type` entries with
 * NO values. Arrays are described once under a `[]`-suffixed path (union of element shapes); an
 * empty array is `path:array(empty)`; null is `path:null`. Pure and total — never throws.
 */
export function describePayloadShape(node: unknown, prefix = ''): string[] {
  const label = (kind: string): string => (prefix === '' ? kind : `${prefix}:${kind}`);
  if (node === null) return [label('null')];
  if (Array.isArray(node)) {
    if (node.length === 0) return [label('array(empty)')];
    const out = new Set<string>();
    for (const item of node) {
      for (const entry of describePayloadShape(item, `${prefix}[]`)) out.add(entry);
    }
    return [...out].sort();
  }
  if (typeof node === 'object') {
    const out = new Set<string>();
    for (const [key, value] of Object.entries(node)) {
      const childPrefix = prefix === '' ? key : `${prefix}.${key}`;
      for (const entry of describePayloadShape(value, childPrefix)) out.add(entry);
    }
    return [...out].sort();
  }
  return [label(typeof node)];
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
const EMAIL_FIELDS = new Set(['email', 'email_address', 'contact_email', 'customer_email']);

// --- PII normalization (issue #35) ------------------------------------------------------------
// Values are normalized to a canonical form BEFORE hashing so the same person hashes identically
// regardless of formatting (punctuation, case, spacing), and so incidental non-PII leaves scooped
// up under a broad PII key (e.g. the "work" label inside a phone object) are dropped rather than
// hashed as noise. Normalizers return null for a value that is not a plausible instance of the
// type; a null value is not hashed.

/** Minimum digit count for a leaf under a phone-labeled key to be treated as a phone number.
 *  Drops labels ("work"), extensions ("x12"), and short sequence numbers. */
const MIN_PHONE_DIGITS = 7;

/** Canonical phone: digits only, preserving a single leading `+` when the input had one. */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Canonical name: trimmed, internal whitespace collapsed, lowercased. */
export function normalizeName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return name.length > 0 ? name : null;
}

/** Canonical email: trimmed, lowercased; must look like an address. */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.includes('@') ? email : null;
}

/** Normalize each raw value for its type, drop the non-plausible ones, dedupe, then hash. */
function normalizedHmacs(
  values: string[],
  normalize: (v: string) => string | null,
  hashOne: (v: string) => string,
): string[] {
  const canonical = new Set<string>();
  for (const v of values) {
    const n = normalize(v);
    if (n !== null) canonical.add(n);
  }
  return [...canonical].map(hashOne);
}

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
export function collectPii(value: unknown): {
  phones: string[];
  names: string[];
  emails: string[];
} {
  const phones = new Set<string>();
  const names = new Set<string>();
  const emails = new Set<string>();

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
      } else if (EMAIL_FIELDS.has(lower)) {
        collectLeaves(v, emails);
      } else {
        walk(v); // keep scanning deeper for PII-labeled keys
      }
    }
  };

  walk(value);
  return { phones: [...phones], names: [...names], emails: [...emails] };
}

/**
 * Build the non-PII metadata allowlist by resolving each canonical field from its known-equivalent
 * paths (top-level, camelCase, or nested under a `call`/`data` wrapper). Output KEY names are the
 * stable snake_case contract the Task 3.1 pre-filter reads — only the input shapes are tolerant.
 */
function nonPiiMetadata(claims: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const direction = resolveScalar(claims, DIRECTION_PATHS, 'string');
  if (direction !== undefined) out.direction = direction;
  const state = resolveScalar(claims, STATE_PATHS, 'string');
  if (state !== undefined) out.state = state;
  const duration = resolveScalar(claims, DURATION_PATHS, 'number');
  if (duration !== undefined) out.duration = duration;
  const isInternal = resolveScalar(claims, IS_INTERNAL_PATHS, 'boolean');
  if (isInternal !== undefined) out.is_internal = isInternal;
  const operatorCallId = resolveScalar(claims, OPERATOR_ID_PATHS, 'id');
  if (operatorCallId !== undefined) out.operator_call_id = String(operatorCallId);
  const masterCallId = resolveScalar(claims, MASTER_ID_PATHS, 'id');
  if (masterCallId !== undefined) out.master_call_id = String(masterCallId);
  const dateStarted = resolveScalar(claims, DATE_STARTED_PATHS, 'number');
  if (dateStarted !== undefined) out.date_started = dateStarted;
  const dateEnded = resolveScalar(claims, DATE_ENDED_PATHS, 'number');
  if (dateEnded !== undefined) out.date_ended = dateEnded;
  return out;
}

/**
 * Metadata for `call_state.source_metadata` — the Task 3.1 pre-filter's input. `call_state` is
 * retained indefinitely, so this is a STRICT non-PII allowlist: no phone/name, not even hashed.
 */
export function toCallStateMetadata(claims: Record<string, unknown>): Record<string, JsonValue> {
  return nonPiiMetadata(claims);
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
    ...nonPiiMetadata(result.claims),
  };
  const callId = resolveCallId(result.claims);
  if (callId !== undefined) payload.call_id = callId;
  if (typeof claims.iat === 'number') payload.iat = claims.iat;

  const { phones, names, emails } = collectPii(result.claims);
  const phoneHmac = normalizedHmacs(phones, normalizePhone, hashOne);
  const nameHmac = normalizedHmacs(names, normalizeName, hashOne);
  const emailHmac = normalizedHmacs(emails, normalizeEmail, hashOne);
  if (phoneHmac.length > 0) payload.phone_hmac = phoneHmac;
  if (nameHmac.length > 0) payload.name_hmac = nameHmac;
  if (emailHmac.length > 0) payload.email_hmac = emailHmac;

  return payload;
}
