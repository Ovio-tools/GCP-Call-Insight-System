import { residualScan } from '../../redaction/residual-scan.js';
import { TOKEN_PATTERN } from '../../redaction/types.js';
import { URGENCY, type Urgency } from '../../db/enums.js';
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
 * Runs the independent residual-PII scan over each ORIGINAL phrase (before any token
 * handling) and merges the per-category counts. A single hit in any phrase fails the
 * gate. Returns COUNTS ONLY, never phrase text.
 *
 * Takes a plain `string[]` so BOTH content gates share one audited merge: the extract
 * handler passes `record.customer_language`, and the verbatim-pii-scan stage passes the
 * PERSISTED `candidate.customer_language`.
 */
export function scanPhrasesForResidual(
  phrases: readonly string[],
  denyTerms: readonly string[],
): { hit: false } | { hit: true; counts: Record<string, number> } {
  const merged: Record<string, number> = {};
  let any = false;

  for (const phrase of phrases) {
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

/**
 * Light normalization for the verbatim check and the emergency haystack: lowercase,
 * fold curly apostrophes (U+2018/U+2019) to a straight one, collapse whitespace, trim.
 *
 * The apostrophe fold is load-bearing for the emergency SAFETY gate: ASR/typed
 * transcripts frequently render `won't`/`can't` with a curly U+2019, and no upstream
 * stage normalizes quotes, so `won’t shut off` would otherwise miss the ambiguous
 * keyword literals (which use a straight apostrophe). Folding both sides of the match
 * equally is harmless for the verbatim gate.
 */
function normalizeLight(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Verbatim-gate normalization (issue #61): lowercase, drop apostrophes (so
 * won't/won’t/wont coincide), then map EVERY other non-alphanumeric run to a
 * single space and trim. Deliberately more aggressive than {@link normalizeLight}
 * and PRIVATE to the verbatim gate — the emergency SAFETY gate keeps normalizeLight
 * unchanged.
 *
 * The point is to tolerate the benign punctuation/whitespace differences a faithful
 * model quote picks up against ASR text (an added/dropped comma, hyphen-vs-space)
 * WITHOUT loosening word matching: the gate still asks for the phrase's words as a
 * contiguous substring, so a changed word, an inserted word, or a skipped middle
 * word all break contiguity and still fail. Only punctuation, case, apostrophes,
 * and whitespace are ignored.
 */
function normalizeForVerbatim(s: string): string {
  return s
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Result of the verbatim gate (issue #63). `phrases` is the KEPT set the handler
 * persists: exact matches kept as-is, plus near-verbatim phrases SNAPPED to the real
 * source span. Every entry is guaranteed to be an exact substring of `redactedText`.
 * The three counters are for observability only — never phrase text.
 */
export interface VerbatimResult {
  phrases: string[];
  exactCount: number;
  snappedCount: number;
  droppedCount: number;
}

/**
 * Minimum word-level similarity for a phrase to SNAP to a source span rather than be
 * dropped. Deliberately conservative (favor dropping over a wrong snap, per issue #63):
 * a single reworded word in a 4+-word phrase scores ~0.75 (snaps), while a 2-word phrase
 * with one word changed scores 0.5 (drops), and a fabrication scores near 0. A fixed,
 * tested constant rather than an env var — a knob would only institutionalize drift.
 */
const SNAP_MIN_SIMILARITY = 0.7;

interface SourceWord {
  norm: string;
  start: number;
  end: number;
}

/**
 * Tokenize `text` into normalized words WITH their original-text spans, using the same
 * folding as {@link normalizeForVerbatim}: lowercase, apostrophes dropped (so `won't`
 * is one word `wont`), every other non-alphanumeric run is a separator. `start`/`end`
 * index into the ORIGINAL text so a matched window can be sliced back out verbatim.
 */
function tokenizeWithSpans(text: string): SourceWord[] {
  const words: SourceWord[] = [];
  let cur = '';
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const ch = i < text.length ? text[i]! : '';
    const isApostrophe = ch === "'" || ch === '‘' || ch === '’';
    const lower = ch.toLowerCase();
    const isAlnum = lower >= 'a' && lower <= 'z' ? true : lower >= '0' && lower <= '9';
    if (isAlnum) {
      if (start === -1) start = i;
      cur += lower;
    } else if (isApostrophe) {
      // Dropped, not a separator: mirrors normalizeForVerbatim removing apostrophes.
    } else if (start !== -1) {
      words.push({ norm: cur, start, end: i });
      cur = '';
      start = -1;
    }
  }
  return words;
}

/** Normalized word list for a phrase — same folding as the source tokenizer. */
function normalizeWords(s: string): string[] {
  return normalizeForVerbatim(s)
    .split(' ')
    .filter((w) => w.length > 0);
}

/** Longest-common-subsequence length over two word arrays (order-preserving). */
function wordLcs(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Find the source span best aligned to `pwords` by word-level LCS similarity. Slides
 * windows of length m-1, m, m+1 (tolerating one insertion/deletion) and keeps the
 * highest-scoring one. Returns the span (into the original text) and its similarity,
 * or null if the source has no words. Similarity = LCS / max(phraseLen, windowLen).
 */
function bestSnapSpan(
  pwords: readonly string[],
  source: readonly SourceWord[],
): { start: number; end: number; similarity: number } | null {
  const m = pwords.length;
  if (m === 0 || source.length === 0) return null;
  let best: { start: number; end: number; similarity: number } | null = null;
  for (const len of [m - 1, m, m + 1]) {
    if (len < 1) continue;
    for (let s = 0; s + len <= source.length; s += 1) {
      const window = source.slice(s, s + len);
      const similarity =
        wordLcs(
          pwords,
          window.map((w) => w.norm),
        ) / Math.max(m, len);
      if (best === null || similarity > best.similarity) {
        best = { start: window[0]!.start, end: window[len - 1]!.end, similarity };
      }
    }
  }
  return best;
}

/**
 * The verbatim gate (issue #63). For each phrase:
 *  - EXACT (substring after {@link normalizeForVerbatim}) → kept as-is (`exactCount`).
 *  - else NEAR a real span (word-LCS similarity ≥ {@link SNAP_MIN_SIMILARITY}) → replaced
 *    with that source span, an exact substring of `redactedText` (`snappedCount`).
 *  - else → dropped (`droppedCount`); the model likely fabricated it.
 *
 * The exact check runs FIRST so issue #61's punctuation tolerance is preserved unchanged,
 * and only previously-failing phrases enter the snap/drop path. Never returns phrase text
 * in the counters. The handler runs this on ORIGINAL phrases; `phrases` is the set it
 * persists (all guaranteed to be exact substrings of the redacted text).
 */
export function verbatimGate(phrases: readonly string[], redactedText: string): VerbatimResult {
  const haystack = normalizeForVerbatim(redactedText);
  const source = tokenizeWithSpans(redactedText);
  const kept: string[] = [];
  let exactCount = 0;
  let snappedCount = 0;
  let droppedCount = 0;

  for (const phrase of phrases) {
    const norm = normalizeForVerbatim(phrase);
    if (norm.length === 0 || haystack.includes(norm)) {
      kept.push(phrase);
      exactCount += 1;
      continue;
    }
    const snap = bestSnapSpan(normalizeWords(phrase), source);
    if (snap !== null && snap.similarity >= SNAP_MIN_SIMILARITY) {
      kept.push(redactedText.slice(snap.start, snap.end));
      snappedCount += 1;
    } else {
      droppedCount += 1;
    }
  }

  return { phrases: kept, exactCount, snappedCount, droppedCount };
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

/**
 * Least→most-urgent ladder, DERIVED from `URGENCY` (which is declared most→least in
 * db/enums.ts) so it cannot drift out of the enum: reversing `['emergency','urgent',
 * 'routine']` yields `['routine','urgent','emergency']`, i.e. "up the ladder".
 */
const URGENCY_LADDER: Urgency[] = [...URGENCY].reverse();

function upgradeOneLevel(urgency: Urgency): Urgency {
  const idx = URGENCY_LADDER.indexOf(urgency);
  return URGENCY_LADDER[Math.min(idx + 1, URGENCY_LADDER.length - 1)] ?? urgency;
}

/** The constant trigger ids the rule may emit — M5's handler branches on these. */
export type EmergencyTrigger =
  'model_urgency' | 'call_intent' | 'emergency_keyword' | 'ambiguous_upgrade';

export function emergencyRule(
  record: ExtractionRecord,
  redactedText: string,
): { urgency: Urgency; hold: boolean; triggers: EmergencyTrigger[] } {
  const haystack = normalizeLight(
    [redactedText, record.problem_statement, ...record.symptoms, ...record.concerns].join(' '),
  );

  const triggers: EmergencyTrigger[] = [];

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
