/**
 * Offset-producing mirrors of the residual scan's sub-scan semantics (Task 4.1c,
 * ADR 0007). The residual scanner reports categories and counts only — these
 * finders locate the SAME surfaces as `{start, end}` spans into a given text so
 * the primary layers can redact them FIRST, making residual holds impossible by
 * construction for every value-backed category.
 *
 * residual-scan.ts stays byte-for-byte unchanged as the independent auditor, so
 * its private constants and normalizers are deliberately duplicated here, not
 * imported. The mirror/residual parity suite in
 * test/redaction/mirror-finders.test.ts pins fire/no-fire equivalence against
 * the real scanner — drift between the two is a test failure, not a silent gap.
 */

export interface MirrorSpan {
  /** Inclusive start offset into the text given to the finder. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * Offset-mapped mirror of the residual's `normalizeAggressive` (lowercase, ALL
 * non-alphanumerics removed): `chars[i]` is a kept character and `map[i]` is the
 * index it came from in the source text.
 */
interface AggressiveShadow {
  chars: string;
  map: number[];
}

function aggressiveShadow(text: string): AggressiveShadow {
  const kept: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    // Per-char lowercasing can expand (e.g. 'İ' → 'i' + combining dot); every
    // expanded char that survives the [a-z0-9] filter maps back to the source char.
    for (const c of (text[i] as string).toLowerCase()) {
      if (/[a-z0-9]/.test(c)) {
        kept.push(c);
        map.push(i);
      }
    }
  }
  return { chars: kept.join(''), map };
}

/** Map a shadow-coordinate hit back to source-text offsets. */
function shadowSpan(shadow: AggressiveShadow, start: number, length: number): MirrorSpan {
  return {
    start: shadow.map[start] as number,
    end: (shadow.map[start + length - 1] as number) + 1,
  };
}

function normalizeAggressive(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Lowercase alphanumeric word tokens WITH source offsets (mirror of `wordTokens`). */
function wordTokensWithOffsets(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/[a-zA-Z0-9]+/g)) {
    out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Mirror of the residual `digit_run` rule (`\d{7,}` over the aggressively
 * normalized text): maximal runs of >= 7 digits where only non-alphanumerics —
 * including spaces, punctuation, and NEWLINES — intervene; any letter breaks the
 * run. The span covers first digit → last digit, so a run crossing a
 * speaker-line boundary deliberately swallows the separator (over-redaction is
 * accepted; the alternative is a residual hold).
 */
export function findLongDigitRuns(text: string): MirrorSpan[] {
  const shadow = aggressiveShadow(text);
  const out: MirrorSpan[] = [];
  for (const m of shadow.chars.matchAll(/\d{7,}/g)) {
    out.push(shadowSpan(shadow, m.index, m[0].length));
  }
  return out;
}

/** Mirror of the residual's spoken-digit vocabulary. "oh" counts; bare "o" does not. */
const DIGIT_WORDS = new Set([
  'zero',
  'oh',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'double',
  'triple',
]);
const DIGIT_WORD_MULTIPLIER = new Map<string, number>([
  ['double', 2],
  ['triple', 3],
]);
const SPELLED_DIGITS_MIN = 7;

/**
 * Mirror of the residual `spelled_out_digits` automaton, producing spans: runs
 * of >= 7 spoken digits ("five five five, oh one, two three four"), with
 * double/triple as multipliers. Word splitting mirrors the residual's
 * letters-only split, so intervening digits/punctuation do not close a run. The
 * span covers the first contributing word (including a leading multiplier)
 * through the last digit word.
 */
export function findSpelledDigitRuns(text: string): MirrorSpan[] {
  const out: MirrorSpan[] = [];
  let run = 0;
  let pendingMultiplier = 1;
  let runStart: number | undefined;
  let runEnd: number | undefined;

  const closeRun = (): void => {
    if (run >= SPELLED_DIGITS_MIN && runStart !== undefined && runEnd !== undefined) {
      out.push({ start: runStart, end: runEnd });
    }
    run = 0;
    pendingMultiplier = 1;
    runStart = undefined;
    runEnd = undefined;
  };

  for (const m of text.matchAll(/[a-zA-Z]+/g)) {
    const word = m[0].toLowerCase();
    const multiplier = DIGIT_WORD_MULTIPLIER.get(word);
    if (multiplier !== undefined) {
      pendingMultiplier = multiplier;
      // A multiplier can open the span ("double five five …") but never ends it.
      runStart ??= m.index;
      continue;
    }
    if (DIGIT_WORDS.has(word)) {
      run += pendingMultiplier;
      pendingMultiplier = 1;
      runStart ??= m.index;
      runEnd = m.index + m[0].length;
    } else {
      closeRun();
    }
  }
  closeRun();
  return out;
}

/**
 * Mirror of the residual greeting cues, with a GREEDY capitalized-run capture
 * (strong cue: 1..n tokens; weak cue: 2..n) where the residual matches only the
 * first one/two. Greedy is required for dominance: if only a prefix of the name
 * were redacted, the token-stripped output ("my name is  Damme") would still
 * match the residual's cue regex (its `\s+` spans the gap) and hold.
 */
const GREETING_STRONG_GREEDY =
  /\b(?:my\s+name\s+is|ask\s+for|speaking\s+with)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)*)/dg;
const GREETING_WEAK_GREEDY = /\b(?:this\s+is|it'?s)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)+)/dg;

export function findGreetingNames(text: string): MirrorSpan[] {
  const out: MirrorSpan[] = [];
  for (const pattern of [GREETING_STRONG_GREEDY, GREETING_WEAK_GREEDY]) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const captured = m.indices?.[1];
      if (captured) out.push({ start: captured[0], end: captured[1] });
    }
  }
  return out;
}

/** Mirrors of the residual email shapes (confusable at-signs; spoken at + literal-or-spoken dot). */
const EMAIL_AT_SIGN_MIRROR = /[a-z0-9_%+-]+\s*[@＠﹫]\s*[a-z0-9.-]+/gi;
const EMAIL_SPOKEN_MIRROR =
  /\b[a-z0-9]+\s+at\s+[a-z0-9]+(?:\s*(?:\.|\bdot\b)\s*|\.)(?:com|net|org|edu|gov|io)\b/gi;

export function findEmailLike(text: string): MirrorSpan[] {
  const out: MirrorSpan[] = [];
  for (const pattern of [EMAIL_AT_SIGN_MIRROR, EMAIL_SPOKEN_MIRROR]) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      out.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** Below this many normalized chars a value is too short to recheck (residual floor). */
const REINTRO_MIN_CHARS = 3;
/** At/above this, the collapsed-substring match is safe (residual threshold). */
const REINTRO_CONCAT_MIN_CHARS = 8;

/** All non-overlapping occurrences of `needle` in the shadow, as source spans. */
function collapsedOccurrences(shadow: AggressiveShadow, needle: string): MirrorSpan[] {
  const out: MirrorSpan[] = [];
  let from = 0;
  for (;;) {
    const idx = shadow.chars.indexOf(needle, from);
    if (idx === -1) break;
    out.push(shadowSpan(shadow, idx, needle.length));
    from = idx + needle.length;
  }
  return out;
}

/**
 * Mirror of the residual `deny_list_term` recheck: aggressive collapsed-substring
 * containment (so "AcmePlumbingSupply" and "A-c-m-e P-l-u-m-b-i-n-g" both
 * match), needle >= 3 normalized chars. Located here rather than widening the
 * primary deny-list detector's whole-word semantics: whole-word stays the
 * precision-friendly first pass; this mirror closes the residual gap.
 */
export function findDenyTermOccurrences(text: string, terms: readonly string[]): MirrorSpan[] {
  const shadow = aggressiveShadow(text);
  const out: MirrorSpan[] = [];
  for (const term of terms) {
    const needle = normalizeAggressive(term);
    if (needle.length < REINTRO_MIN_CHARS) continue;
    out.push(...collapsedOccurrences(shadow, needle));
  }
  return out;
}

/**
 * Mirror of the residual `vault_value_reintroduced` matching (see
 * `reintroduced()` in residual-scan.ts): long values (>= 8 normalized chars)
 * match on the punctuation-collapsed text (catching "David? Rolando" and
 * "j-o-h-n s-m-i-t-h" splits); short values (3–7) match as whole-word
 * sequences; anything under 3 normalized chars never matches (so a vaulted "I"
 * can never propagate). The exported `isVaultValueReintroduced` predicate from
 * residual-scan.ts remains the authoritative post-condition — this finder only
 * locates what that predicate flags.
 */
export function findVaultOccurrences(text: string, plaintext: string): MirrorSpan[] {
  const needle = normalizeAggressive(plaintext);
  if (needle.length < REINTRO_MIN_CHARS) return [];

  if (needle.length >= REINTRO_CONCAT_MIN_CHARS) {
    return collapsedOccurrences(aggressiveShadow(text), needle);
  }

  const needleWords = plaintext
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (needleWords.length === 0) return [];
  const hay = wordTokensWithOffsets(text);
  const out: MirrorSpan[] = [];
  for (let i = 0; i + needleWords.length <= hay.length; i += 1) {
    let match = true;
    for (let j = 0; j < needleWords.length; j += 1) {
      if (hay[i + j]!.word !== needleWords[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      out.push({ start: hay[i]!.start, end: hay[i + needleWords.length - 1]!.end });
      i += needleWords.length - 1;
    }
  }
  return out;
}

/** Mirror of the residual address lexicon + window. */
const ADDRESS_KEYWORD_MIRROR =
  /\b(street|avenue|boulevard|address|apartment|apt|suite|zip\s*code|zip)\b/gi;
const ADDRESS_WINDOW_CHARS = 40;

/**
 * Mirror of the residual `address_like` rule (address keyword with any digit
 * within 40 chars): returns the maximal digit runs intersecting each firing
 * window — the digits, never the keyword, get redacted. Digits near an address
 * keyword are plausibly address components (zip, house, apartment numbers);
 * a text where they are not would residual-hold today, so redacting them is a
 * hold→redact conversion, never a new loss.
 */
export function findAddressWindowDigits(text: string): MirrorSpan[] {
  const windows: MirrorSpan[] = [];
  ADDRESS_KEYWORD_MIRROR.lastIndex = 0;
  for (const m of text.matchAll(ADDRESS_KEYWORD_MIRROR)) {
    windows.push({
      start: Math.max(0, m.index - ADDRESS_WINDOW_CHARS),
      end: Math.min(text.length, m.index + m[0].length + ADDRESS_WINDOW_CHARS),
    });
  }
  if (windows.length === 0) return [];

  const seen = new Set<string>();
  const out: MirrorSpan[] = [];
  for (const run of text.matchAll(/\d+/g)) {
    const start = run.index;
    const end = start + run[0].length;
    const inWindow = windows.some((w) => start < w.end && end > w.start);
    if (!inWindow) continue;
    const key = `${String(start)}:${String(end)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ start, end });
    }
  }
  return out;
}
