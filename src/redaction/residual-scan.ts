import { TOKEN_PATTERN } from './types.js';

/**
 * Independent residual-PII scan over the REDACTED output (Task 4.1). Any hit
 * fails closed: the stage holds the call with residual_pii_detected and never
 * writes the text to clean_transcripts.
 *
 * Independence: this module shares NO patterns or normalizers with the primary
 * detectors — only TOKEN_PATTERN, which describes our own output format (tokens
 * are stripped before scanning so their digits/words never self-trigger). The
 * sub-scans are deliberately stricter and dumber than the primary layers: a
 * false hold costs review time; a false pass costs the privacy boundary.
 *
 * The result carries CATEGORIES AND COUNTS ONLY — never values or offsets — so
 * it is safe to persist in redaction_findings.residual_scan_result and to log.
 */

export interface ResidualScanResult {
  hits: { category: string }[];
  counts: Record<string, number>;
}

export interface ResidualScanInput {
  redactedText: string;
  /** Every plaintext the primary layers vaulted — rechecked against the output. */
  vaultPlaintexts: readonly string[];
  denyTerms: readonly string[];
}

/** Aggressive normalization PRIVATE to this scanner: lowercase, ALL non-alphanumerics
 * removed. Stricter than the primary deny-list normalizer on purpose. */
function normalizeAggressive(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Number words for the spelled-out-digit scan. "oh" counts as zero; bare "o" does not. */
const DIGIT_WORDS = new Map<string, number>([
  ['zero', 1],
  ['oh', 1],
  ['one', 1],
  ['two', 1],
  ['three', 1],
  ['four', 1],
  ['five', 1],
  ['six', 1],
  ['seven', 1],
  ['eight', 1],
  ['nine', 1],
  // "double five" speaks two digits.
  ['double', 0],
  ['triple', 0],
]);
const DIGIT_WORD_MULTIPLIER = new Map<string, number>([
  ['double', 2],
  ['triple', 3],
]);
const SPELLED_DIGITS_MIN = 7;

/** Consecutive spoken digits: "five five five, oh one, two three four". */
function spelledOutDigitRuns(words: readonly string[]): number {
  let runs = 0;
  let run = 0;
  let pendingMultiplier = 1;
  const closeRun = (): void => {
    if (run >= SPELLED_DIGITS_MIN) runs += 1;
    run = 0;
    pendingMultiplier = 1;
  };
  for (const word of words) {
    const multiplier = DIGIT_WORD_MULTIPLIER.get(word);
    if (multiplier !== undefined) {
      pendingMultiplier = multiplier;
      continue;
    }
    if (DIGIT_WORDS.has(word)) {
      run += pendingMultiplier;
      pendingMultiplier = 1;
    } else {
      closeRun();
    }
  }
  closeRun();
  return runs;
}

// Email-ish shapes: any at-sign (incl. Unicode confusables) between word-ish runs,
// or a spoken " at ... dot <tld>" form.
const EMAIL_AT_SIGN = /[a-z0-9_%+-]+\s*[@＠﹫]\s*[a-z0-9.-]+/gi;
const EMAIL_SPOKEN =
  /\b[a-z0-9]+\s+at\s+[a-z0-9]+(?:\s*(?:\.|\bdot\b)\s*|\.)(?:com|net|org|edu|gov|io)\b/gi;

// Own address lexicon (NOT shared with the primary): keywords that should not
// survive redaction near a number. "unit"/"drive"/"court" are excluded — too
// common in trade calls ("the unit is leaking") to hold on.
const ADDRESS_KEYWORD =
  /\b(street|avenue|boulevard|address|apartment|apt|suite|zip\s*code|zip)\b/gi;
const ADDRESS_WINDOW_CHARS = 40;

// Name shapes after greeting cues. Strong cues hold on a single Capitalized word;
// the weak cue ("this is") requires a Capitalized bigram to limit false holds.
const GREETING_STRONG = /\b(?:my\s+name\s+is|ask\s+for|speaking\s+with)\s+([A-Z][a-z'-]+)/g;
const GREETING_WEAK = /\b(?:this\s+is|it'?s)\s+([A-Z][a-z'-]+\s+[A-Z][a-z'-]+)/g;

export function residualScan(input: ResidualScanInput): ResidualScanResult {
  // Strip our own tokens first so [PHONE_3456789] digits never self-trigger.
  const text = input.redactedText.replace(TOKEN_PATTERN, ' ');
  const normalized = normalizeAggressive(text);
  const words = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  const counts: Record<string, number> = {};
  const add = (category: string, n: number): void => {
    if (n > 0) counts[category] = (counts[category] ?? 0) + n;
  };

  // 1. Vault-originals recheck — catches replacement/offset bugs.
  add(
    'vault_value_reintroduced',
    input.vaultPlaintexts.filter((p) => {
      const needle = normalizeAggressive(p);
      return needle.length >= 3 && normalized.includes(needle);
    }).length,
  );

  // 2a. Digit runs: >= 7 digits ignoring ALL intervening non-alphanumerics.
  add('digit_run', (normalized.match(/\d{7,}/g) ?? []).length);

  // 2b. Spelled-out digit sequences.
  add('spelled_out_digits', spelledOutDigitRuns(words));

  // 2c. Email-ish shapes (incl. Unicode confusable at-signs).
  add('email_like', (text.match(EMAIL_AT_SIGN) ?? []).length);
  add('email_like', (text.match(EMAIL_SPOKEN) ?? []).length);

  // 2d. Address keywords with a number nearby.
  let addressHits = 0;
  for (const m of text.matchAll(ADDRESS_KEYWORD)) {
    const from = Math.max(0, m.index - ADDRESS_WINDOW_CHARS);
    const to = Math.min(text.length, m.index + m[0].length + ADDRESS_WINDOW_CHARS);
    if (/\d/.test(text.slice(from, to))) addressHits += 1;
  }
  add('address_like', addressHits);

  // 2e. Capitalized name shapes right after greeting cues.
  add(
    'name_like_after_greeting',
    (text.match(GREETING_STRONG) ?? []).length + (text.match(GREETING_WEAK) ?? []).length,
  );

  // 3. Deny-list recheck under the aggressive normalization.
  add(
    'deny_list_term',
    input.denyTerms.filter((t) => {
      const needle = normalizeAggressive(t);
      return needle.length >= 3 && normalized.includes(needle);
    }).length,
  );

  const hits = Object.entries(counts).flatMap(([category, n]) =>
    Array.from({ length: n }, () => ({ category })),
  );
  return { hits, counts };
}
