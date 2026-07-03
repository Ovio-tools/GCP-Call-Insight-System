import { residualScan } from '../../redaction/residual-scan.js';
import { TOKEN_PATTERN } from '../../redaction/types.js';
import type { Urgency } from '../../db/enums.js';
import type { ExtractionRecord } from './parse.js';

/**
 * Deterministic extract-stage gates — a PURE module. No DB, no logger, no network.
 *
 * These are pure functions applied by the handler (M5) in a fixed order:
 * residual scan FIRST (PII precedence), then verbatim, token, and emergency rule.
 * `denyTerms` is always a PARAMETER — the handler loads the deny list, not the gate.
 *
 * No gate ever returns or logs phrase text: counts, booleans, and constant ids only.
 */

/**
 * Runs the independent residual-PII scan over each ORIGINAL `customer_language`
 * phrase (before any token handling) and merges the per-category counts. A single
 * hit in any phrase fails the gate. Returns COUNTS ONLY, never phrase text.
 */
export function scanCustomerLanguage(
  record: ExtractionRecord,
  denyTerms: readonly string[],
): { hit: false } | { hit: true; counts: Record<string, number> } {
  const merged: Record<string, number> = {};
  let any = false;

  for (const phrase of record.customer_language) {
    const { counts } = residualScan({ redactedText: phrase, vaultPlaintexts: [], denyTerms });
    for (const [category, n] of Object.entries(counts)) {
      if (n > 0) {
        merged[category] = (merged[category] ?? 0) + n;
        any = true;
      }
    }
  }

  return any ? { hit: true, counts: merged } : { hit: false };
}

/** Light normalization for the verbatim check: lowercase, collapse whitespace, trim. */
function normalizeLight(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Every phrase must appear (after light normalization) in `redactedText`. Returns
 * the count of phrases that do NOT appear — never the phrase text. The handler runs
 * this on ORIGINAL phrases for the in-memory gate.
 */
export function verbatimGate(
  phrases: readonly string[],
  redactedText: string,
): { ok: true } | { ok: false; mismatchCount: number; phraseCount: number } {
  const haystack = normalizeLight(redactedText);
  let mismatchCount = 0;
  for (const phrase of phrases) {
    if (!haystack.includes(normalizeLight(phrase))) mismatchCount += 1;
  }
  return mismatchCount === 0
    ? { ok: true }
    : { ok: false, mismatchCount, phraseCount: phrases.length };
}

/**
 * Drops every phrase that contains a redaction token. `TOKEN_PATTERN` carries the
 * `g` flag (stateful `.test()`/`.exec()`), so we use `.match` with a fresh, global
 * regex per call — no shared `lastIndex` to leak between calls.
 */
export function tokenGate(phrases: readonly string[]): { phrases: string[]; droppedCount: number } {
  const kept: string[] = [];
  let droppedCount = 0;
  for (const phrase of phrases) {
    // Fresh regex per phrase: never rely on TOKEN_PATTERN's mutable lastIndex.
    const hasToken = new RegExp(TOKEN_PATTERN.source).test(phrase);
    if (hasToken) droppedCount += 1;
    else kept.push(phrase);
  }
  return { phrases: kept, droppedCount };
}

/**
 * Deterministic tiered urgency rule (plan §5). `triggers` are CONSTANT snake_case
 * ids ONLY — never matched text. Emergency overrides the model upward; ambiguous
 * upgrades one level from the MODEL's urgency.
 */
const EMERGENCY_KEYWORDS = [
  'gas leak',
  'smell gas',
  'smell of gas',
  'gas smell',
  'carbon monoxide',
  'sewage backup',
  'sewage backing up',
  'raw sewage',
  'sewage in',
  'burst pipe',
  'pipe burst',
  'pipe has burst',
  'flooding',
  'flooded',
  'water everywhere',
  'water pouring',
  'water gushing',
] as const;

const AMBIGUOUS_KEYWORDS = [
  'active leak',
  'leaking right now',
  'cannot shut off',
  "can't shut off",
  "won't shut off",
  "water won't stop",
  'no water at all',
  'no usable toilet',
  'only toilet',
] as const;

/** Case-insensitive, whitespace-normalized, word-boundary keyword match. */
function haystackContains(haystack: string, keyword: string): boolean {
  const normalizedKeyword = normalizeLight(keyword);
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`).test(haystack);
}

const URGENCY_LADDER: Urgency[] = ['routine', 'urgent', 'emergency'];

function upgradeOneLevel(urgency: Urgency): Urgency {
  const idx = URGENCY_LADDER.indexOf(urgency);
  return URGENCY_LADDER[Math.min(idx + 1, URGENCY_LADDER.length - 1)] ?? urgency;
}

export function emergencyRule(
  record: ExtractionRecord,
  redactedText: string,
): { urgency: Urgency; hold: boolean; triggers: string[] } {
  const haystack = normalizeLight(
    [redactedText, record.problem_statement, ...record.symptoms, ...record.concerns].join(' '),
  );

  const triggers: string[] = [];

  // --- EMERGENCY tier: any hit overrides the model urgency to emergency + hold. ---
  if (record.urgency === 'emergency') triggers.push('model_urgency');
  if (record.call_intent === 'emergency') triggers.push('call_intent');
  if (EMERGENCY_KEYWORDS.some((k) => haystackContains(haystack, k))) {
    triggers.push('emergency_keyword');
  }

  const emergencyFired =
    triggers.includes('model_urgency') ||
    triggers.includes('call_intent') ||
    triggers.includes('emergency_keyword');

  // --- AMBIGUOUS tier: upgrade one level from the MODEL's urgency. ---
  const ambiguousFired = AMBIGUOUS_KEYWORDS.some((k) => haystackContains(haystack, k));
  if (ambiguousFired) triggers.push('ambiguous_upgrade');

  if (emergencyFired) {
    // Emergency wins: emergency + hold, regardless of any ambiguous match.
    return { urgency: 'emergency', hold: true, triggers };
  }

  if (ambiguousFired) {
    const upgraded = upgradeOneLevel(record.urgency);
    return { urgency: upgraded, hold: upgraded === 'emergency', triggers };
  }

  // Neither tier fired — pass the model's urgency through unchanged.
  return { urgency: record.urgency, hold: false, triggers: [] };
}
