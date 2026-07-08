import type { RiskReason } from './risk-reasons.js';

/**
 * Contracts for the layered PII detection pipeline (Task 4.1).
 *
 * Three detector layers (NER, regex, deny-list) all speak this vocabulary; the
 * span merger, tokenizer, risk scorer, and stage handler compose over it. Raw
 * detected values live ONLY as `[start, end)` offsets into the original text —
 * never copied into these structures — so nothing here can leak into logs.
 */

/** Detection vocabulary: what kind of PII a span is. */
export const ENTITY_TYPES = [
  'name',
  'location',
  'organization',
  'phone',
  'email',
  'street_address',
  'cross_street',
  'credit_card',
  'government_id',
  'number',
  'deny_list',
  'other',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * NER entity-scope policy vocabulary (ADR 0006): which NER detection types are
 * actually redacted. `person` = PER spans; `numbered_location` = LOC spans only
 * when a house-style number is directly adjacent (suffix-less addresses);
 * `location` / `organization` / `misc` opt back in to bare places, business
 * names, and MISC — i.e. the pre-ADR-0006 redact-everything behavior. Lives
 * here (not in the detector) so the config schema can import it without
 * touching the transformers.js module.
 */
export const NER_ENTITY_SCOPES = [
  'person',
  'numbered_location',
  'location',
  'organization',
  'misc',
] as const;

export type NerEntityScope = (typeof NER_ENTITY_SCOPES)[number];

/**
 * `redaction_findings.entity_type` vocabulary: every detection type plus the
 * call-level residual-scan record the stage always writes (one per call, carrying
 * categories/counts only). Typed here so building that row needs no casts.
 */
export type FindingEntityType = EntityType | 'residual_scan';

/** One detected span. Offsets are char positions into the ORIGINAL text. */
export interface Detection {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  entityType: EntityType;
  detector: 'ner' | 'regex' | 'deny_list';
  /** NER only — mean wordpiece score across the span. */
  confidence?: number;
}

/**
 * A non-span risk signal a detector raises — the typed path for fail-closed
 * conditions (a failed offset alignment, a truncated chunk, an address-like
 * near-miss). No side channels: if a detector knows something is wrong, it says
 * so here and the risk scorer turns it into a hold.
 */
export interface RiskSignal {
  reason: RiskReason;
}

export interface DetectorResult {
  detections: readonly Detection[];
  riskSignals: readonly RiskSignal[];
}

export interface Detector {
  readonly name: string;
  detect(text: string): Promise<DetectorResult>;
}

/**
 * The shape of our own redaction tokens, e.g. `[NAME_1]`, `[PHONE_2]`. Shared with
 * the residual scanner — the ONE permitted shared artifact, because it describes
 * our output format, not detection logic (the scanner strips tokens before it
 * scans so their digits/words never self-trigger).
 */
export const TOKEN_PATTERN = /\[[A-Z_]+_\d+\]/g;

/** Builds a token label for an entity type + per-call sequence number. */
export function tokenLabel(entityType: EntityType, n: number): string {
  return `[${entityType.toUpperCase()}_${String(n)}]`;
}
